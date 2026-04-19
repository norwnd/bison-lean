// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package dex

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
)

// contextManager is used to manage a context and its cancellation function.
type contextManager struct {
	mtx    sync.RWMutex
	cancel context.CancelFunc
	ctx    context.Context
}

// init uses the passed context to create and save a child context and
// its cancellation function.
func (cm *contextManager) init(ctx context.Context) {
	cm.mtx.Lock()
	defer cm.mtx.Unlock()
	cm.ctx, cm.cancel = context.WithCancel(ctx)
}

// Active will be true until the context is canceled.
//
// Naming note: separate from ConnectionMaster.Running (defined below
// in the same file) — contextManager tracks the context-canceled state
// of a StartStopWaiter-managed subsystem, which is a distinct concern
// from whether a Connector-backed connection is still live.
func (cm *contextManager) Active() bool {
	cm.mtx.RLock()
	defer cm.mtx.RUnlock()
	return cm.ctx != nil && cm.ctx.Err() == nil
}

// Runner is satisfied by DEX subsystems, which must start any of their
// goroutines via the Run method.
type Runner interface {
	Run(ctx context.Context)
	// Ready() <-chan struct{}
}

// StartStopWaiter wraps a Runner, providing the non-blocking Start and Stop
// methods, and the blocking WaitForShutdown method.
type StartStopWaiter struct {
	contextManager
	wg     sync.WaitGroup
	runner Runner
}

// NewStartStopWaiter creates a StartStopWaiter from a Runner.
func NewStartStopWaiter(runner Runner) *StartStopWaiter {
	return &StartStopWaiter{
		runner: runner,
	}
}

// Start launches the Runner in a goroutine. Start will return immediately. Use
// Stop to signal the Runner to stop, followed by WaitForShutdown to allow
// shutdown to complete.
func (ssw *StartStopWaiter) Start(ctx context.Context) {
	ssw.init(ctx)
	ssw.wg.Add(1)
	go func() {
		ssw.runner.Run(ssw.ctx)
		ssw.cancel() // in case it stopped on its own
		ssw.wg.Done()
	}()
	// TODO: do <-ssw.runner.Ready()
}

// WaitForShutdown blocks until the Runner has returned in response to Stop.
func (ssw *StartStopWaiter) WaitForShutdown() {
	ssw.wg.Wait()
}

// Stop cancels the context.
func (ssw *StartStopWaiter) Stop() {
	ssw.mtx.RLock()
	ssw.cancel()
	ssw.mtx.RUnlock()
}

// Connector is any type that implements the Connect method, which will return
// a connection error, and a WaitGroup that can be waited on at Disconnection.
type Connector interface {
	Connect(ctx context.Context) (*sync.WaitGroup, error)
}

// connState tracks the lifecycle of a ConnectionMaster's connect
// attempt. Transitions are strictly monotonic
// (Unset → Started → Finished) and the machine is single-use: once
// Finished, it stays Finished for the life of the ConnectionMaster.
type connState int32

const (
	// connStateUnset is the initial state — Connect/ConnectOnce has
	// not been called yet.
	connStateUnset connState = 0
	// connStateStarted is set (via CompareAndSwap from Unset) at the
	// top of Connect, before the wrapped Connector.Connect call. The
	// CAS is the single-use guard: a second Connect/ConnectOnce on
	// the same ConnectionMaster panics here.
	connStateStarted connState = 1
	// connStateFinished is set (via defer) when Connect returns.
	// Naming note: Connect reaching this state does NOT imply the
	// wrapped Connector connected successfully — a non-nil error
	// from Connector.Connect still transitions to Finished (that's
	// expected in the Connect (vs. ConnectOnce) case where the
	// Connector does its own retry loop). "Finished" reads as
	// "Connect function returned", which is what's being tracked.
	// Disconnect's panic guard checks for this state.
	connStateFinished connState = 2
)

// ConnectionMaster manages a Connector.
//
// Lifecycle invariants, enforced with panics at the responsible methods:
//   - Connect (or ConnectOnce) must be called exactly once per
//     ConnectionMaster instance. A second call panics in Connect
//     (the Unset→Started CompareAndSwap on connectState fails).
//   - Disconnect must be called only after Connect has returned.
//     Calling earlier panics in Disconnect (connectState is not yet
//     Finished — see connState docs for why "returned" is the right
//     framing rather than "succeeded").
//   - To retry a connection that errored, mint a fresh
//     ConnectionMaster via NewConnectionMaster. Instances are
//     single-use; there is no Reset.
//
// Violating any invariant is a caller bug, and the panics exist to
// surface such bugs loudly rather than let them corrupt state silently.
type ConnectionMaster struct {
	// connector is the actual connection ConnectionMaster wraps/manages
	connector Connector
	// wg is WaitGroup associated with Connector so that ConnectionMaster is able to tell
	// when Connector is done, it's atomic so ConnectionMaster can work in concurrent setting
	wg atomic.Pointer[sync.WaitGroup]
	// ctxCancel is a cancel for ctx passed down to wrapped Connector, it's used to forcefully
	// terminate wrapped Connector if necessary, it's atomic so ConnectionMaster can work
	// in concurrent setting. Stored as *context.CancelFunc (pointer to the function value)
	// because atomic.Pointer's type parameter can't be a function type directly.
	ctxCancel atomic.Pointer[context.CancelFunc]
	// connectState holds a connState tracking the connect-attempt
	// lifecycle: Unset → Started → Finished. Stored as int32 so
	// CompareAndSwap is available (Go has no atomic primitive over
	// custom int32-backed types yet). This single Int32 replaces a
	// prior pair of atomic.Bool (connectInitiated + connectCompleted)
	// — the pair had a TOCTOU gap in the single-use check, which
	// the CAS-based transition from Unset → Started now closes.
	connectState atomic.Int32
	// running indicates if the Connector is running (meaning ConnectionMaster instance is still
	// relevant to keep around and use). Set to true exactly once by Connect after the
	// wrapped Connector returns. Cleared to false by whichever of these fires first:
	//   - Disconnect (explicit shutdown), or
	//   - the internal wg-watcher goroutine spawned by Connect when the wrapped
	//     Connector reports a WaitGroup (the Connector shut itself down).
	// Both writes are idempotent, so the ordering doesn't matter.
	running atomic.Bool
}

// NewConnectionMaster creates a new ConnectionMaster.
func NewConnectionMaster(c Connector) *ConnectionMaster {
	return &ConnectionMaster{
		connector: c,
	}
}

// Connect connects the Connector, and returns any initial connection error. Disconnect
// method may be called to shut down the Connector and stop it from automatically retrying
// to connect further (as well as release associated resources).
// Even if Connect returns a non-nil error, Running may report true until Disconnect is called.
//
// Connect (or ConnectOnce) must be called at most 1 time per ConnectionMaster instance.
//
// You would use Connect if the wrapped Connector has a reconnect loop to continually
// attempt to establish a connection even if the initial attempt fails. Use ConnectOnce
// if the Connector should be given only one chance to connect.
func (c *ConnectionMaster) Connect(ctx context.Context) error {
	// Trying to call Connect (or ConnectOnce) multiple times is probably a bug on
	// the caller side; sanity check we aren't doing that (panic to spot this
	// sooner). The Unset → Started transition is a single CompareAndSwap so two
	// concurrent Connect calls can't both pass this check — only the winning CAS
	// proceeds; the loser panics.
	if !c.connectState.CompareAndSwap(int32(connStateUnset), int32(connStateStarted)) {
		panic("ConnectionMaster.Connect spotted multiple connect attempts on single ConnectionMaster instance")
	}

	defer c.connectState.Store(int32(connStateFinished))

	// prepare dedicated context for wrapped Connector
	ctx, cancel := context.WithCancel(ctx)
	c.ctxCancel.Store(&cancel)

	// make an initial attempt to start wrapped Connector, a non-nil error does not indicate
	// that wrapped Connector is not running, only that the initial connection attempt has
	// failed, hence we have to set c.running to true regardless to signal we didn't give up on
	// this connection just yet
	wg, err := c.connector.Connect(ctx)
	if wg != nil {
		// non-nil WaitGroup means Connector can communicate back to us to tell us when it is
		// done with this connection (and hence when this ConnectionMaster instance is no
		// longer relevant, no longer considered to be running)
		go func() {
			wg.Wait()
			c.running.Store(false) // ConnectionMaster instance is no longer relevant
			// release context resources only after wrapped Connector has finished, we have to
			// cancel context ourselves here because we cannot rely on ConnectionMaster caller
			// to always call Disconnect method just so resources are freed
			cancel()
		}()
	} else {
		// we have to initialize c.wg on our own so ConnectionMaster caller(s) can use
		// Done/Wait/Disconnect methods regardless of whether connect succeeded or not
		wg = &sync.WaitGroup{}
		wg.Add(1)
		go func() {
			<-ctx.Done() // expecting corresponding cancel call to be issued through Disconnect
			wg.Done()
		}()
	}
	// note: c.wg must be initialized before c.running is set to true for ConnectionMaster.Done
	// method to work properly
	c.wg.Store(wg)
	c.running.Store(true) // error or not, ConnectionMaster instance is regarded as relevant
	if err != nil {
		return fmt.Errorf("connect failure: %w", err)
	}

	return nil
}

// ConnectOnce is similar to Connect but is designed to be used with Connector that is meant
// to try connecting only 1 time (meaning Connector cannot recover from unsuccessful connect
// attempt on his own).
// If ConnectOnce returns nil error - Disconnect method must be called to clean up associated
// resources.
func (c *ConnectionMaster) ConnectOnce(ctx context.Context) error {
	err := c.Connect(ctx)
	if err != nil {
		// disconnect here explicitly to prevent any retries wrapped Connector might want to
		// do as well as clean up associated resources automatically (it's not customary to
		// expect the caller do a cleanup on error cases)
		c.Disconnect()
		return err
	}
	return nil
}

// Running indicates if the Connector is running (meaning ConnectionMaster instance is still
// relevant to keep around and use).
//
// Naming note: separate from contextManager.Active (defined above in
// the same file) — ConnectionMaster.Running tracks whether a wrapped
// Connector is still live, which is a distinct concern from whether a
// StartStopWaiter's context has been canceled.
func (c *ConnectionMaster) Running() bool {
	return c.running.Load()
}

// Done returns a channel that is closed when the Connector's WaitGroup is done.
// If called before Connect method has finished, a closed channel is returned.
func (c *ConnectionMaster) Done() <-chan struct{} {
	if !c.running.Load() {
		closedChan := make(chan struct{})
		close(closedChan)
		return closedChan
	}

	done := make(chan struct{})
	go func() {
		wg := c.wg.Load()
		wg.Wait()
		close(done)
	}()

	return done
}

// Wait waits for the Connector to shut down. It returns immediately if
// Connect method hasn't finished yet.
func (c *ConnectionMaster) Wait() {
	<-c.Done()
}

// Disconnect closes the connection and waits for shutdown. This method is meant to be used
// only AFTER connection has been established (through Connect or ConnectOnce method).
// It's the caller responsibility to always call it only AFTER Connect method has finished.
func (c *ConnectionMaster) Disconnect() {
	// Trying to call Disconnect before Connect (or ConnectOnce) has returned is
	// probably a bug on the caller side; sanity check we aren't doing that (panic
	// to spot this sooner). Note this does NOT mean the wrapped Connector
	// succeeded — see connState docs for why "finished" is the right framing.
	if connState(c.connectState.Load()) != connStateFinished {
		panic("ConnectionMaster.Disconnect called before Connect/ConnectOnce returned")
	}

	c.running.Store(false) // ConnectionMaster instance is no longer relevant

	cancel := c.ctxCancel.Load()
	(*cancel)()
	c.Wait()
}
