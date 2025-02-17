// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package websocket

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"decred.org/dcrdex/client/core"
	"decred.org/dcrdex/client/orderbook"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/msgjson"
	"decred.org/dcrdex/dex/ws"
)

var (
	// Time allowed to read the next pong message from the peer. The
	// default is intended for production, but leaving as a var instead of const
	// to facilitate testing.
	pongWait = 60 * time.Second
	// Send pings to peer with this period. Must be less than pongWait. The
	// default is intended for production, but leaving as a var instead of const
	// to facilitate testing.
	pingPeriod = (pongWait * 9) / 10
	// A client id counter.
	cidCounter int32
)

type bookFeed struct {
	core.BookFeed
	loop        *dex.StartStopWaiter
	host        string
	base, quote uint32
}

// wsClient is a persistent websocket connection to a client.
type wsClient struct {
	*ws.WSLink
	cid int32

	feedMtx sync.RWMutex
	feed    *bookFeed
}

func newWSClient(addr string, conn ws.Connection, hndlr func(msg *msgjson.Message) *msgjson.Error, logger dex.Logger) *wsClient {
	return &wsClient{
		WSLink: ws.NewWSLink(addr, conn, pingPeriod, hndlr, logger),
		cid:    atomic.AddInt32(&cidCounter, 1),
	}
}

func (cl *wsClient) shutDownFeed() {
	if cl.feed != nil {
		cl.feed.loop.Stop()
		cl.feed.loop.WaitForShutdown()
		cl.feed = nil
	}
}

// Core specifies the needed methods for Server to operate. Satisfied by *core.Core.
type Core interface {
	SyncBook(dex string, base, quote uint32) (*orderbook.OrderBook, core.BookFeed, error)
	AckNotes([]dex.Bytes)
}

// Server is a websocket hub that tracks all running websocket clients, allows
// sending notifications to all of them, and manages per-client order book
// subscriptions.
type Server struct {
	core Core
	log  dex.Logger
	wg   sync.WaitGroup

	clientsMtx sync.RWMutex
	clients    map[int32]*wsClient
}

// New returns a new websocket Server.
func New(core Core, log dex.Logger) *Server {
	return &Server{
		core:    core,
		log:     log,
		clients: make(map[int32]*wsClient),
	}
}

// Shutdown gracefully shuts down all connected clients, waiting for them to
// disconnect and any running goroutines and message handlers to return.
func (s *Server) Shutdown() {
	s.clientsMtx.Lock()
	for _, cl := range s.clients {
		cl.Disconnect()
	}
	s.clientsMtx.Unlock()
	// Each upgraded connection handler must return. This also waits for running
	// marketSyncers and response handlers as long as dex/ws.(*WSLink) operates
	// as designed and each (*Server).connect goroutine waits for the link's
	// WaitGroup before returning.
	s.wg.Wait()
}

// HandleConnect handles the websocket connection request, creating a
// ws.Connection and a connect thread. Since the http.Request's Context is
// canceled after ServerHTTP returns, a separate context must be provided to be
// able to cancel the hijacked connection handler at a later time since this
// function is not blocking.
func (s *Server) HandleConnect(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	wsConn, err := ws.NewConnection(w, r, pongWait)
	if err != nil {
		s.log.Errorf("ws connection error: %v", err)
		return
	}

	// wsConn.SetReadLimit(65536) // if websocket reads need to be larger than ws.defaultReadLimit

	// Launch the handler for the upgraded connection. Shutdown will wait for
	// these to return.
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.connect(ctx, wsConn, r.RemoteAddr)
	}()
}

// connect handles a new websocket client by creating a new wsClient, starting
// it, and blocking until the connection closes. This method should be
// run as a goroutine.
func (s *Server) connect(ctx context.Context, conn ws.Connection, addr string) {
	s.log.Debugf("New websocket client %s", addr)
	// Create a new websocket client to handle the new websocket connection
	// and wait for it to shut down.  Once it has shutdown (and hence
	// disconnected), remove it.
	var cl *wsClient
	cl = newWSClient(addr, conn, func(msg *msgjson.Message) *msgjson.Error {
		return s.handleMessage(cl, msg)
	}, s.log.SubLogger(addr))

	// Lock the clients map before starting the connection listening so that
	// synchronized map accesses are guaranteed to reflect this connection.
	// Also, ensuring only live connections are in the clients map notify from
	// sending before it is connected.
	s.clientsMtx.Lock()
	cm := dex.NewConnectionMaster(cl)
	err := cm.ConnectOnce(ctx) // we discard the cm anyway, but good practice
	if err != nil {
		s.clientsMtx.Unlock()
		s.log.Errorf("websocketHandler client connect: %v", err)
		return
	}

	// Add the client to the map only after it is connected so that notify does
	// not attempt to send to non-existent connection.
	s.clients[cl.cid] = cl
	s.clientsMtx.Unlock()

	defer func() {
		cl.feedMtx.Lock()
		cl.shutDownFeed()
		cl.feedMtx.Unlock()

		s.clientsMtx.Lock()
		delete(s.clients, cl.cid)
		s.clientsMtx.Unlock()
	}()

	cm.Wait() // also waits for any handleMessage calls in (*WSLink).inHandler
	s.log.Tracef("Disconnected websocket client %s", addr)
}

// Notify sends a notification to the websocket client.
func (s *Server) Notify(route string, payload any) {
	msg, err := msgjson.NewNotification(route, payload)
	if err != nil {
		s.log.Errorf("%q notification encoding error: %v", route, err)
		return
	}
	s.clientsMtx.RLock()
	defer s.clientsMtx.RUnlock()
	for _, cl := range s.clients {
		if err = cl.Send(msg); err != nil {
			s.log.Warnf("Failed to send %v notification to client %v at %v: %v",
				msg.Route, cl.cid, cl.Addr(), err)
		}
	}
}

// handleMessage handles the websocket message, calling the right handler for
// the route.
func (s *Server) handleMessage(conn *wsClient, msg *msgjson.Message) *msgjson.Error {
	s.log.Tracef("message of type %d received for route %s", msg.Type, msg.Route)
	if msg.Type == msgjson.Request {
		handler, found := wsHandlers[msg.Route]
		if !found {
			return msgjson.NewError(msgjson.UnknownMessageType, "unknown route %q", msg.Route)
		}
		return handler(s, conn, msg)
	}
	// Web server doesn't send requests, only responses and notifications, so
	// a response-type message from a client is an error.
	return msgjson.NewError(msgjson.UnknownMessageType, "web server only handles requests")
}

// All request handlers must be defined with this signature.
type wsHandler func(*Server, *wsClient, *msgjson.Message) *msgjson.Error

// wsHandlers is the map used by the server to locate the router handler for a
// request.
var wsHandlers = map[string]wsHandler{
	"loadmarket":  wsLoadMarket,
	"loadcandles": wsLoadCandles,
	"unmarket":    wsUnmarket,
	"acknotes":    wsAckNotes,
}

// marketLoad is sent by websocket clients to subscribe to a market and request
// the order book.
type marketLoad struct {
	Host  string `json:"host"`
	Base  uint32 `json:"base"`
	Quote uint32 `json:"quote"`
}

type candlesLoad struct {
	marketLoad
	Dur string `json:"dur"`
}

// marketSyncer is used to synchronize market subscriptions. The marketSyncer
// manages a map of clients who are subscribed to the market, and distributes
// order book updates when received.
type marketSyncer struct {
	log  dex.Logger
	feed core.BookFeed
	cl   *wsClient
}

// newMarketSyncer is the constructor for a marketSyncer, returned as a running
// *dex.StartStopWaiter.
func newMarketSyncer(cl *wsClient, feed core.BookFeed, log dex.Logger) *dex.StartStopWaiter {
	ssWaiter := dex.NewStartStopWaiter(&marketSyncer{
		feed: feed,
		cl:   cl,
		log:  log,
	})
	ssWaiter.Start(context.Background()) // wrapping Run with a cancel bound to Stop
	return ssWaiter
}

// Run starts the marketSyncer listening for BookUpdates, which it relays to the
// websocket client as notifications.
func (m *marketSyncer) Run(ctx context.Context) {
out:
	for {
		select {
		case update, ok := <-m.feed.Next():
			if !ok {
				// We are skipping m.feed.Close if the feed were closed (external sig).
				return
			}
			note, err := msgjson.NewNotification(update.Action, update)
			if err != nil {
				m.log.Errorf("error encoding notification message: %v", err)
				break out
			}
			err = m.cl.Send(note)
			if err != nil {
				m.log.Debugf("send error. ending market feed: %v", err)
				break out
			}
		case <-ctx.Done():
			break out
		}
	}
	m.feed.Close()
}

// wsLoadMarket is the handler for the 'loadmarket' websocket route. Subscribes
// the client to the notification feed and sends the order book.
func wsLoadMarket(s *Server, cl *wsClient, msg *msgjson.Message) *msgjson.Error {
	req := new(marketLoad)
	err := json.Unmarshal(msg.Payload, req)
	if err != nil {
		return msgjson.NewError(msgjson.RPCInternal, "error unmarshalling marketload payload: %v", err)
	}
	_, msgErr := loadMarket(s, cl, req)
	return msgErr
}

func loadMarket(s *Server, cl *wsClient, req *marketLoad) (*bookFeed, *msgjson.Error) {
	cl.feedMtx.Lock()
	defer cl.feedMtx.Unlock()

	if cl.feed != nil && cl.feed.host == req.Host && cl.feed.base == req.Base && cl.feed.quote == req.Quote {
		return cl.feed, nil
	}

	name, err := dex.MarketName(req.Base, req.Quote)
	if err != nil {
		return nil, msgjson.NewError(msgjson.UnknownMarketError, "unknown market: %v", err)
	}

	_, feed, err := s.core.SyncBook(req.Host, req.Base, req.Quote)
	if err != nil {
		return nil, msgjson.NewError(msgjson.RPCOrderBookError, "error getting order feed: %v", err)
	}

	cl.shutDownFeed()
	cl.feed = &bookFeed{
		BookFeed: feed,
		loop:     newMarketSyncer(cl, feed, s.log.SubLogger(name)),
		host:     req.Host,
		base:     req.Base,
		quote:    req.Quote,
	}
	return cl.feed, nil
}

func wsLoadCandles(s *Server, cl *wsClient, msg *msgjson.Message) *msgjson.Error {
	req := new(candlesLoad)
	err := json.Unmarshal(msg.Payload, req)
	if err != nil {
		return msgjson.NewError(msgjson.RPCInternal, "error unmarshalling candlesLoad payload: %v", err)
	}

	feed, msgErr := loadMarket(s, cl, &req.marketLoad)
	if msgErr != nil {
		return msgErr
	}
	err = feed.Candles(req.Dur)
	if err != nil {
		return msgjson.NewError(msgjson.RPCInternal, "%v", err)
	}
	return nil
}

// wsUnmarket is the handler for the 'unmarket' websocket route. This empty
// message is sent when the user leaves the markets page. This closes the feed,
// and potentially unsubscribes from orderbook with the server if there are no
// other consumers
func wsUnmarket(_ *Server, cl *wsClient, _ *msgjson.Message) *msgjson.Error {
	cl.feedMtx.Lock()
	cl.shutDownFeed()
	cl.feedMtx.Unlock()

	return nil
}

type ackNoteIDs []dex.Bytes

// wsAckNotes is the handler for the 'acknotes' websocket route. It informs the
// Core that the user has seen the specified notifications.
func wsAckNotes(s *Server, _ *wsClient, msg *msgjson.Message) *msgjson.Error {
	ids := make(ackNoteIDs, 0)
	err := msg.Unmarshal(&ids)
	if err != nil {
		s.log.Errorf("error acking notifications: %v", err)
		return nil
	}
	s.core.AckNotes(ids)
	return nil
}
