const typeRequest = 1

export type NoteReceiver = (payload: any) => void

function forward (route: string, payload: any, handlers: Record<string, NoteReceiver[]>) {
  if (!route && payload.error) {
    const err = payload.error
    console.error(`websocket error (code ${err.code}): ${err.message}`)
    return
  }
  if (typeof handlers[route] === 'undefined') {
    return
  }
  for (let i = 0; i < handlers[route].length; i++) {
    handlers[route][i](payload)
  }
}

let id = 0

export class MessageSocket {
  uri: string | null
  connection: WebSocket | null
  handlers: Record<string, NoteReceiver[]>
  queue: [string, any][]
  maxQlength: number

  constructor () {
    this.uri = null
    this.handlers = {}
    this.queue = []
    this.maxQlength = 5
  }

  registerRoute (route: string, handler: NoteReceiver) {
    this.handlers[route] = this.handlers[route] || []
    this.handlers[route].push(handler)
  }

  deregisterRoute (route: string) {
    this.handlers[route] = []
  }

  request (route: string, payload: any) {
    if (!this.connection || this.connection.readyState !== window.WebSocket.OPEN) {
      while (this.queue.length > this.maxQlength - 1) this.queue.shift()
      this.queue.push([route, payload])
      return
    }
    id++
    const message = JSON.stringify({
      route: route,
      type: typeRequest,
      id: id,
      payload: payload
    })
    this.connection.send(message)
  }

  close (_reason: string) {
    this.handlers = {}
    if (this.connection) this.connection.close()
  }

  // `onOpen` fires on every successful WebSocket open — both the
  // first one after `connect()` and every reconnect. It is the
  // place to refresh server-derived state (`/api/user`, etc.) so
  // the store catches up on whatever happened while the WS was
  // closed (or, on first connect, any auth/notification activity
  // that landed between login and the WS subscriber being live).
  connect (uri: string, onOpen: () => void) {
    this.uri = uri

    let retrys = 0

    const go = () => {
      let conn: WebSocket | null = this.connection = new window.WebSocket(uri)
      if (!conn) return
      const timeout = setTimeout(() => {
        if (conn) conn.close()
      }, 2500)

      conn.onmessage = (evt: MessageEvent) => {
        const message = JSON.parse(evt.data)
        forward(message.route, message.payload, this.handlers)
      }

      conn.onclose = (evt: CloseEvent) => {
        clearTimeout(timeout)
        conn = this.connection = null
        // Drop any queued requests on disconnect. The queue is meant to
        // bridge the narrow gap between `request()` being called and
        // the first `onopen`; replaying it across a reconnect can fire
        // session-sensitive payloads (e.g. `acknotes`) at a server
        // whose state has since changed (restart, DB wipe, etc.).
        this.queue = []
        forward('close', null, this.handlers)
        retrys++
        const delay = Math.min(Math.pow(1.25, retrys), 10)
        console.error(`websocket disconnected (${evt.code}), trying again in ${delay.toFixed(1)} seconds`)
        setTimeout(() => { go() }, delay * 1000)
      }

      conn.onopen = () => {
        clearTimeout(timeout)
        onOpen()
        retrys = 0
        forward('open', null, this.handlers)
        const queue = this.queue
        this.queue = []
        for (const [route, message] of queue) {
          this.request(route, message)
        }
      }

      conn.onerror = (evt: Event) => {
        forward('error', evt, this.handlers)
      }
    }
    go()
  }
}

const ws = new MessageSocket()
export default ws
