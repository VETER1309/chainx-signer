import StorageService from './StorageService'
import getRandomValues from 'get-random-values'
import createHash from 'create-hash'
import WebSocket from 'isomorphic-ws'

const suffix = '/socket.io/?EIO=3&transport=websocket'

const sha256 = data =>
  createHash('sha256')
    .update(data)
    .digest('hex')

const random = () => {
  const array = new Uint8Array(24)
  getRandomValues(array)
  return array.join('')
}

export default class SocketService {
  constructor(name) {
    this.plugin = name

    this.socket = null
    this.connected = false
    this.paired = false
    this.openRequests = []
    this.pairingPromise = null
    this.eventHandlers = {}

    this.appkey = StorageService.getAppKey()
    if (!this.appkey) this.appkey = 'appkey:' + random()
  }

  addEventHandler(handler, key) {
    if (!key) key = 'app'
    this.eventHandlers[key] = handler
  }

  removeEventHandler(key) {
    if (!key) key = 'app'
    delete this.eventHandlers[key]
  }

  link() {
    return new Promise(async resolve => {
      const setupSocket = () => {
        this.socket.onmessage = msg => {
          // Handshaking/Upgrading
          if (msg.data.indexOf('42/chainx') === -1) return false

          // Real message
          const [type, data] = JSON.parse(msg.data.replace('42/chainx,', ''))

          if (type === 'pong') return
          if (type === 'ping') return this.socket.send(`42/chainx,["pong"]`)

          switch (type) {
            case 'paired':
              return msg_paired(data)
            case 'rekey':
              return msg_rekey()
            case 'api':
              return msg_api(data)
            case 'event':
              return event_api(data)
            default:
              console.log(`Unknown type message ${type}`)
          }
        }

        const msg_paired = result => {
          this.paired = result

          if (this.paired) {
            const savedKey = StorageService.getAppKey()
            const hashed =
              this.appkey.indexOf('appkey:') > -1
                ? sha256(this.appkey)
                : this.appkey

            if (!savedKey || savedKey !== hashed) {
              StorageService.setAppKey(hashed)
              this.appkey = StorageService.getAppKey()
            }
          }

          this.pairingPromise.resolve(result)
        }

        const msg_rekey = () => {
          this.appkey = 'appkey:' + random()
          this.send('rekeyed', {
            data: { appkey: this.appkey, origin: this.getOrigin() },
            plugin: this.plugin
          })
        }

        const msg_api = response => {
          if (typeof response === 'string') {
            try {
              response = JSON.parse(response)
            } catch (e) {
              console.error('Error parsing json for response: ', response)
            }
          }

          const openRequest = this.openRequests.find(
            x => x.payload.id === response.id
          )
          if (!openRequest) return

          this.openRequests = this.openRequests.filter(
            x => x.payload.id !== response.id
          )

          const isErrorResponse =
            response.error !== null && response.error !== undefined

          if (isErrorResponse) {
            openRequest.reject(response.error)
          } else {
            openRequest.resolve(response.result)
          }
        }

        const event_api = ({ event, payload }) => {
          if (Object.keys(this.eventHandlers).length)
            Object.keys(this.eventHandlers).map(key => {
              this.eventHandlers[key](event, payload)
            })
        }
      }

      const getHostname = port => {
        return `127.0.0.1:${port}`
      }

      const targetPort = await new Promise(async portResolver => {
        const startingPort = 10013

        for (const i of [...new Array(5).keys()]) {
          const port = startingPort + i * 13
          const host = `http://${getHostname(port)}`
          try {
            const res = await fetch(host)
            const text = await res.text()
            if (text === 'chainx') {
              portResolver(port)
              return
            }
          } catch (e) {
            console.log(`port ${port} failed, try to test another port`)
          }
        }

        portResolver(startingPort)
      })

      const trySocket = port =>
        new Promise(socketResolver => {
          const hostname = getHostname(port)
          const protocol = 'ws://'
          const s = new WebSocket(`${protocol}${hostname}${suffix}`)

          s.onerror = () => socketResolver(false)
          s.onopen = () => socketResolver(s)
        })

      const s = await trySocket(targetPort)
      if (s) {
        this.socket = s
        this.send()
        this.connected = true
        setupSocket()
        this.pairingPromise = null
        this.pair(true).then(() => resolve(true))
      }
    })
  }

  isConnected() {
    return this.connected
  }

  isPaired() {
    return this.paired
  }

  disconnect() {
    if (this.socket) this.socket.close()
    return true
  }

  sendApiRequest(payload) {
    return new Promise((resolve, reject) => {
      this.pair().then(() => {
        if (!this.paired)
          return reject({
            code: 'not_paired',
            message:
              'The user did not allow this app to connect to their chainx'
          })

        const request = {}

        // Set Application Key
        request.appkey = this.appkey
        // Nonce used to authenticate this request
        request.nonce = StorageService.getNonce() || 0
        // Next nonce used to authenticate the next request
        const nextNonce = random()
        request.nextNonce = sha256(nextNonce)
        StorageService.setNonce(nextNonce)

        request.payload = payload
        request.payload.origin = this.getOrigin()
        request.payload.id = random()

        this.openRequests.push(Object.assign(request, { resolve, reject }))

        this.send('api', { data: request, plugin: this.plugin })
      })
    })
  }

  pair(passthrough = false) {
    return new Promise((resolve, reject) => {
      this.pairingPromise = { resolve, reject }
      this.send('pair', {
        data: { appkey: this.appkey, origin: this.getOrigin(), passthrough },
        plugin: this.plugin
      })
    })
  }

  send(type = null, data = null) {
    if (type === null && data === null) {
      this.socket.send('40/chainx')
    } else {
      this.socket.send('42/chainx,' + JSON.stringify([type, data]))
    }
  }

  getOrigin() {
    return SocketService.getOriginOrPlugin(this.plugin)
  }

  static getOriginOrPlugin(plugin) {
    let origin
    if (typeof window.location !== 'undefined') {
      if (
        window.location.hasOwnProperty('hostname') &&
        window.location.hostname.length &&
        window.location.hostname !== 'localhost'
      ) {
        origin = window.location.hostname
      } else {
        origin = plugin
      }
    } else {
      origin = plugin
    }
    if (origin.substr(0, 4) === 'www.') {
      origin = origin.replace('www.', '')
    }
    return origin
  }
}
