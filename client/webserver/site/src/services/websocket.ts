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

  connect (uri: string, onReconnect: () => void) {
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
        forward('close', null, this.handlers)
        retrys++
        const delay = Math.min(Math.pow(1.25, retrys), 10)
        console.error(`websocket disconnected (${evt.code}), trying again in ${delay.toFixed(1)} seconds`)
        setTimeout(() => { go() }, delay * 1000)
      }

      conn.onopen = () => {
        clearTimeout(timeout)
        if (retrys > 0) {
          onReconnect()
        }
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
