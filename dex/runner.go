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

// On will be true until the context is canceled.
func (cm *contextManager) On() bool {
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

// ConnectionMaster manages a Connector.
type ConnectionMaster struct {
	// connector is the actual connection ConnectionMaster wraps/manages
	connector Connector
	// wg is WaitGroup associated with Connector so that ConnectionMaster is able to tell
	// when Connector is done, it's atomic so ConnectionMaster can work in concurrent setting
	wg atomic.Value
	// ctxCancel is a cancel for ctx passed down to wrapped Connector, it's used to forcefully
	// terminate wrapped Connector if necessary, it's atomic so ConnectionMaster can work
	// in concurrent setting
	ctxCancel atomic.Value
	// connectInitiated indicates whether connect attempt has been initiated at least once,
	// used for sanity-checks only
	connectInitiated atomic.Bool
	// connectCompleted indicates whether connect attempt has been completed (note, it doesn't
	// necessarily have to succeed since Connector might be doing retries on its side - see
	// Connect / ConnectOnce methods for details)
	connectCompleted atomic.Bool
	// on indicates if the Connector is running (meaning ConnectionMaster instance is still
	// relevant to keep around and use)
	on atomic.Bool
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
// Even if Connect returns a non-nil error, On may report true until Disconnect is called.
//
// Connect (or ConnectOnce) must be called at most 1 time per ConnectionMaster instance.
//
// You would use Connect if the wrapped Connector has a reconnect loop to continually
// attempt to establish a connection even if the initial attempt fails. Use ConnectOnce
// if the Connector should be given only one chance to connect.
func (c *ConnectionMaster) Connect(ctx context.Context) error {
	// trying to call Connect (or ConnectOnce) multiple times is probably a bug on the
	// caller side, sanity check we aren't doing that (panic to spot this sooner)
	if c.connectInitiated.Load() {
		panic("ConnectionMaster.Connect spotted multiple connect attempts on single ConnectionMaster instance")
	}
	c.connectInitiated.Store(true)

	defer c.connectCompleted.Store(true)

	// prepare dedicated context for wrapped Connector
	ctx, cancel := context.WithCancel(ctx)
	c.ctxCancel.Store(cancel)

	// make an initial attempt to start wrapped Connector, a non-nil error does not indicate
	// that wrapped Connector is not running, only that the initial connection attempt has
	// failed, hence we have to set c.on to true regardless to signal we didn't give up on
	// this connection just yet
	wg, err := c.connector.Connect(ctx)
	if wg != nil {
		// non-nil WaitGroup means Connector can communicate back to us to tell us when it is
		// done with this connection (and hence when this ConnectionMaster instance is no
		// longer relevant, no longer considered to be on)
		go func() {
			wg.Wait()
			c.on.Store(false) // ConnectionMaster instance is no longer relevant
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
	// note: c.wg must be initialized before c.on is set to true for ConnectionMaster.Done
	// method to work properly
	c.wg.Store(wg)
	c.on.Store(true) // error or not, ConnectionMaster instance is regarded as relevant
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

// On indicates if the Connector is running (meaning ConnectionMaster instance is still relevant
// to keep around and use).
func (c *ConnectionMaster) On() bool {
	return c.on.Load()
}

// Done returns a channel that is closed when the Connector's WaitGroup is done.
// If called before Connect method has finished, a closed channel is returned.
func (c *ConnectionMaster) Done() <-chan struct{} {
	if !c.on.Load() {
		closedChan := make(chan struct{})
		close(closedChan)
		return closedChan
	}

	done := make(chan struct{})
	go func() {
		wg := c.wg.Load().(*sync.WaitGroup)
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
	// trying to call Disconnect before finishing connection establishing is probably
	// a bug on the caller side, sanity check we aren't doing that (panic to spot this sooner)
	if !c.connectCompleted.Load() {
		panic("ConnectionMaster.Disconnect called BEFORE connection has completed")
	}

	c.on.Store(false) // ConnectionMaster instance is no longer relevant

	cancel := c.ctxCancel.Load().(context.CancelFunc)
	cancel()
	c.Wait()
}
