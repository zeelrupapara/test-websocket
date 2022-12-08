/*
 * Copyright 2020 Richard Schloss (https://github.com/richardeschloss/nuxt-socket-io)
 */

import io from 'socket.io-client'
import consola from 'consola'
import Debug from 'debug'

const debug = Debug('nuxt-socket-io')

function PluginOptions() {
  let _pluginOptions
  if (process.env.TEST === undefined) {
    _pluginOptions = <%= JSON.stringify(options) %>
  }

  return Object.freeze({
    get: () => _pluginOptions,
    set: (opts) => (_pluginOptions = opts)
  })
}

const _pOptions = PluginOptions()

let warn

function camelCase(str) {
  return str
    .replace(/[_\-\s](.)/g, function($1) {
      return $1.toUpperCase()
    })
    .replace(/[-_\s]/g, '')
    .replace(/^(.)/, function($1) {
      return $1.toLowerCase()
    })
    .replace(/[^\w\s]/gi, '')
}

function propExists(obj, path) {
  const exists = path.split('.').reduce((out, prop) => {
    if (out !== undefined && out[prop] !== undefined) {
      return out[prop]
    }
  }, obj)

  return exists !== undefined
}

function parseEntry(entry, entryType) {
  let evt, mapTo, pre, body, post, emitEvt, msgLabel
  if (typeof entry === 'string') {
    let subItems = []
    const items = entry.trim().split(/\s*\]\s*/)
    if (items.length > 1) {
      pre = items[0]
      subItems = items[1].split(/\s*\[\s*/)
    } else {
      subItems = items[0].split(/\s*\[\s*/)
    }
    ;[body, post] = subItems
    if (body.includes('-->')) {
      ;[evt, mapTo] = body.split(/\s*-->\s*/)
    } else if (body.includes('<--')) {
      ;[evt, mapTo] = body.split(/\s*<--\s*/)
    } else {
      evt = body
    }

    if (entryType === 'emitter') {
      ;[emitEvt, msgLabel] = evt.split(/\s*\+\s*/)
    } else if (mapTo === undefined) {
      mapTo = evt
    }
  } else if (entryType === 'emitBack') {
    ;[[mapTo, evt]] = Object.entries(entry)
  } else {
    ;[[evt, mapTo]] = Object.entries(entry)
  }
  return { pre, post, evt, mapTo, emitEvt, msgLabel }
}

function assignMsg(ctx, prop) {
  let msg
  if (prop !== undefined) {
    if (ctx[prop] !== undefined) {
      if (typeof ctx[prop] === 'object') {
        msg = ctx[prop].constructor.name === 'Array' ? [] : {}
        Object.assign(msg, ctx[prop])
      } else {
        msg = ctx[prop]
      }
    } else {
      warn(`prop or data item "${prop}" not defined`)
    }
    debug(`assigned ${prop} to ${msg}`)
  }
  return msg
}

function assignResp(ctx, prop, resp) {
  if (prop !== undefined) {
    if (ctx[prop] !== undefined) {
      if (typeof ctx[prop] !== 'function') {
        ctx[prop] = resp
        debug(`assigned ${resp} to ${prop}`)
      }
    } else {
      warn(`${prop} not defined on instance`)
    }
  }
}

async function runHook(ctx, prop, data) {
  if (prop !== undefined) {
    if (ctx[prop]) return await ctx[prop](data)
    else warn(`method ${prop} not defined`)
  }
}

function propByPath(obj, path) {
  return path.split(/[/.]/).reduce((out, prop) => {
    if (out !== undefined && out[prop] !== undefined) {
      return out[prop]
    }
  }, obj)
}

const register = {
  clientApiEvents({ ctx, store, socket, api }) {
    const { evts } = api
    Object.entries(evts).forEach(([emitEvt, schema]) => {
      const { data: dataT } = schema
      const fn = emitEvt + 'Emit'
      if (ctx[emitEvt] !== undefined) {
        if (dataT !== undefined) {
          Object.entries(dataT).forEach(([key, val]) => {
            ctx.$set(ctx[emitEvt], key, val)
          })
          debug('Initialized data for', emitEvt, dataT)
        }
      }

      if (ctx[fn] !== undefined) return

      ctx[fn] = (fnArgs) => {
        const { label: apiLabel, ack, ...args } = fnArgs || {}
        return new Promise(async (resolve, reject) => {
          const label = apiLabel || api.label
          const msg = Object.keys(args).length > 0 ? args : { ...ctx[emitEvt] }
          msg.method = fn
          if (ack) {
            const ackd = await store.dispatch('$nuxtSocket/emit', {
              label,
              socket,
              evt: emitEvt,
              msg
            })
            resolve(ackd)
          } else {
            store.dispatch('$nuxtSocket/emit', {
              label,
              socket,
              evt: emitEvt,
              msg,
              noAck: true
            })
            resolve()
          }
        })
      }
      debug('Registered clientAPI method', fn)
    })
  },
  clientApiMethods({ ctx, socket, api }) {
    const { methods } = api
    const evts = Object.assign({}, methods, { getAPI: {} })
    Object.entries(evts).forEach(([evt, schema]) => {
      if (socket.hasListeners(evt)) {
        warn(`evt ${evt} already has a listener registered`)
      }

      socket.on(evt, async (msg, cb) => {
        if (evt === 'getAPI') {
          if (cb) cb(api)
        } else if (ctx[evt] !== undefined) {
          msg.method = evt
          const resp = await ctx[evt](msg)
          if (cb) cb(resp)
        } else if (cb) {
          cb({
            emitErr: 'notImplemented',
            msg: `Client has not yet implemented method (${evt})`
          })
        }
      })

      debug(`registered client api method ${evt}`)
      if (evt !== 'getAPI' && ctx[evt] === undefined) {
        warn(
          `client api method ${evt} has not been defined. ` +
            `Either update the client api or define the method so it can be used by callers`
        )
      }
    })
  },
  clientAPI({ ctx, store, socket, clientAPI }) {
    if (clientAPI.methods) {
      register.clientApiMethods({ ctx, socket, api: clientAPI })
    }

    if (clientAPI.evts) {
      register.clientApiEvents({ ctx, store, socket, api: clientAPI })
    }

    store.commit('$nuxtSocket/SET_CLIENT_API', clientAPI)
    debug('clientAPI registered', clientAPI)
  },
  serverApiEvents({ ctx, socket, api, label, ioDataProp, apiIgnoreEvts }) {
    const { evts } = api
    Object.entries(evts).forEach(([evt, entry]) => {
      const { methods = [], data: dataT } = entry
      if (apiIgnoreEvts.includes(evt)) {
        debug(
          `Event ${evt} is in ignore list ("apiIgnoreEvts"), not registering.`
        )
        return
      }

      if (socket.hasListeners(evt)) {
        warn(`evt ${evt} already has a listener registered`)
      }

      methods.forEach((method) => {
        if (ctx[ioDataProp][method] === undefined) {
          ctx.$set(ctx[ioDataProp], method, {})
        }

        ctx.$set(
          ctx[ioDataProp][method],
          evt,
          dataT.constructor.name === 'Array' ? [] : {}
        )
      })

      socket.on(evt, (msg, cb) => {
        const { method, data } = msg
        if (method !== undefined) {
          if (ctx[ioDataProp][method] === undefined) {
            ctx.$set(ctx[ioDataProp], method, {})
          }

          ctx.$set(ctx[ioDataProp][method], evt, data)
        } else {
          ctx.$set(ctx[ioDataProp], evt, data)
        }

        if (cb) {
          cb({ ack: 'ok' })
        }
      })
      debug(`Registered listener for ${evt} on ${label}`)
    })
  },
  serverApiMethods({ ctx, socket, store, api, label, ioApiProp, ioDataProp }) {
    Object.entries(api.methods).forEach(([fn, schema]) => {
      const { msg: msgT, resp: respT } = schema
      if (ctx[ioDataProp][fn] === undefined) {
        ctx.$set(ctx[ioDataProp], fn, {})
        if (msgT !== undefined) {
          ctx.$set(ctx[ioDataProp][fn], 'msg', { ...msgT })
        }

        if (respT !== undefined) {
          ctx.$set(
            ctx[ioDataProp][fn],
            'resp',
            respT.constructor.name === 'Array' ? [] : {}
          )
        }
      }

      ctx[ioApiProp][fn] = (args) => {
        return new Promise(async (resolve, reject) => {
          const emitEvt = fn
          const msg = args !== undefined ? args : { ...ctx[ioDataProp][fn].msg }
          debug(`${ioApiProp}:${label}: Emitting ${emitEvt} with ${msg}`)
          const resp = await store.dispatch('$nuxtSocket/emit', {
            label,
            socket,
            evt: emitEvt,
            msg
          })
          if (respT === undefined) {
            warn(
              `resp not defined on schema for ${fn}. Assigning response as "any" object to ${ioDataProp}`
            )
          }
          ctx[ioDataProp][fn].resp = resp
          resolve(resp)
        })
      }
    })
  },
  async serverAPI({
    ctx,
    socket,
    store,
    label,
    apiIgnoreEvts,
    ioApiProp,
    ioDataProp,
    serverAPI,
    clientAPI = {}
  }) {
    if (ctx[ioApiProp] === undefined) {
      consola.error(
        `[nuxt-socket-io]: ${ioApiProp} needs to be defined in the current context for ` +
          `serverAPI registration (vue requirement)`
      )
      return
    }

    const apiLabel = serverAPI.label || label
    debug('register api for', apiLabel)
    const api = store.state.$nuxtSocket.ioApis[apiLabel] || {}
    const fetchedApi = await store.dispatch('$nuxtSocket/emit', {
      label: apiLabel,
      socket,
      evt: serverAPI.evt || 'getAPI',
      msg: serverAPI.data || {}
    })

    const isPeer =
      clientAPI.label === fetchedApi.label &&
      parseFloat(clientAPI.version) === parseFloat(fetchedApi.version)
    if (isPeer) {
      Object.assign(api, clientAPI)
      store.commit('$nuxtSocket/SET_API', { label: apiLabel, api })
      debug(`api for ${apiLabel} registered`, api)
    } else if (parseFloat(api.version) !== parseFloat(fetchedApi.version)) {
      Object.assign(api, fetchedApi)
      store.commit('$nuxtSocket/SET_API', { label: apiLabel, api })
      debug(`api for ${apiLabel} registered`, api)
    }

    ctx.$set(ctx, ioApiProp, api)

    if (api.methods !== undefined) {
      register.serverApiMethods({
        ctx,
        socket,
        store,
        api,
        label,
        ioApiProp,
        ioDataProp
      })
      debug(
        `Attached methods for ${label} to ${ioApiProp}`,
        Object.keys(api.methods)
      )
    }

    if (api.evts !== undefined) {
      register.serverApiEvents({
        ctx,
        socket,
        api,
        label,
        ioDataProp,
        apiIgnoreEvts
      })
      debug(`registered evts for ${label} to ${ioApiProp}`)
    }

    ctx[ioApiProp].ready = true
    debug('ioApi', ctx[ioApiProp])
  },
  emitErrors({ ctx, err, emitEvt, emitErrorsProp }) {
    if (ctx[emitErrorsProp][emitEvt] === undefined) {
      ctx[emitErrorsProp][emitEvt] = []
    }
    ctx[emitErrorsProp][emitEvt].push(err)
  },
  emitTimeout({ ctx, emitEvt, emitErrorsProp, emitTimeout, timerObj }) {
    return new Promise((resolve, reject) => {
      timerObj.timer = setTimeout(() => {
        const err = {
          message: 'emitTimeout',
          emitEvt,
          emitTimeout,
          hint: [
            `1) Is ${emitEvt} supported on the backend?`,
            `2) Is emitTimeout ${emitTimeout} ms too small?`
          ].join('\r\n'),
          timestamp: Date.now()
        }
        debug('emitEvt timed out', err)
        if (typeof ctx[emitErrorsProp] === 'object') {
          register.emitErrors({ ctx, err, emitEvt, emitErrorsProp })
          resolve()
        } else {
          reject(err)
        }
      }, emitTimeout)
    })
  },
  emitBacks({ ctx, socket, entries }) {
    entries.forEach((entry) => {
      const { pre, post, evt, mapTo } = parseEntry(entry, 'emitBack')
      if (propExists(ctx, mapTo)) {
        debug('registered local emitBack', { mapTo })
        ctx.$watch(mapTo, async function(data, oldData) {
          debug('local data changed', evt, data)
          const preResult = await runHook(ctx, pre, { data, oldData })
          if (preResult === false) {
            return Promise.resolve()
          }
          debug('Emitting back:', { evt, mapTo, data })
          return new Promise((resolve) => {
            socket.emit(evt, { data }, (resp) => {
              runHook(ctx, post, resp)
              resolve(resp)
            })
            if (post === undefined) resolve()
          })
        })
      } else {
        warn(`Specified emitback ${mapTo} is not defined in component`)
      }
    })
  },
  emitBacksVuex({ ctx, store, useSocket, socket, entries }) {
    entries.forEach((entry) => {
      const { pre, post, evt, mapTo } = parseEntry(entry, 'emitBack')

      if (useSocket.registeredWatchers.includes(mapTo)) {
        return
      }

      store.watch(
        (state) => {
          const watchProp = propByPath(state, mapTo)
          if (watchProp === undefined) {
            throw new Error(
              [
                `[nuxt-socket-io]: Trying to register emitback ${mapTo} failed`,
                `because it is not defined in Vuex.`,
                'Is state set up correctly in your stores folder?'
              ].join('\n')
            )
          }
          useSocket.registeredWatchers.push(mapTo)
          debug('emitBack registered', { mapTo })
          return watchProp
        },
        async (data, oldData) => {
          debug('vuex emitBack data changed', { emitBack: evt, data, oldData })
          const preResult = await runHook(ctx, pre, { data, oldData })
          if (preResult === false) {
            return Promise.resolve()
          }
          debug('Emitting back:', { evt, mapTo, data })
          socket.emit(evt, { data }, (resp) => {
            runHook(ctx, post, resp)
          })
        }
      )
    })
  },
  emitters({ ctx, socket, entries, emitTimeout, emitErrorsProp }) {
    entries.forEach((entry) => {
      const { pre, post, mapTo, emitEvt, msgLabel } = parseEntry(
        entry,
        'emitter'
      )
      ctx[emitEvt] = async function(args) {
        const msg = args !== undefined ? args : assignMsg(ctx, msgLabel)
        debug('Emit evt', { emitEvt, msg })
        const preResult = await runHook(ctx, pre, msg)
        if (preResult === false) {
          return Promise.resolve()
        }
        return new Promise((resolve, reject) => {
          const timerObj = {}
          socket.emit(emitEvt, msg, (resp) => {
            debug('Emitter response rxd', { emitEvt, resp })
            clearTimeout(timerObj.timer)
            const { emitError, ...errorDetails } = resp || {}
            if (emitError !== undefined) {
              const err = {
                message: emitError,
                emitEvt,
                errorDetails,
                timestamp: Date.now()
              }
              debug('Emit error occurred', err)
              if (typeof ctx[emitErrorsProp] === 'object') {
                register.emitErrors({
                  ctx,
                  err,
                  emitEvt,
                  emitErrorsProp
                })
                resolve()
              } else {
                reject(err)
              }
            } else {
              assignResp(ctx, mapTo, resp)
              runHook(ctx, post, resp)
              resolve(resp)
            }
          })
          if (emitTimeout) {
            register
              .emitTimeout({
                ctx,
                emitEvt,
                emitErrorsProp,
                emitTimeout,
                timerObj
              })
              .then(resolve)
              .catch(reject)
            debug('Emit timeout registered for evt', { emitEvt, emitTimeout })
          }
        })
      }
      debug('Emitter created', { emitter: emitEvt })
    })
  },
  listeners({ ctx, socket, entries }) {
    entries.forEach((entry) => {
      const { pre, post, evt, mapTo } = parseEntry(entry)
      debug('Registered local listener', evt)
      socket.on(evt, async (resp) => {
        debug('Local listener received data', { evt, resp })
        await runHook(ctx, pre)
        assignResp(ctx, mapTo, resp)
        runHook(ctx, post, resp)
      })
    })
  },
  listenersVuex({ ctx, socket, entries, storeFn, useSocket }) {
    entries.forEach((entry) => {
      const { pre, post, evt, mapTo } = parseEntry(entry)
      async function vuexListenerEvt(resp) {
        debug('Vuex listener received data', { evt, resp })
        await runHook(ctx, pre)
        storeFn(mapTo, resp)
        runHook(ctx, post, resp)
      }

      if (useSocket.registeredVuexListeners.includes(evt)) return

      socket.on(evt, vuexListenerEvt)
      debug('Registered vuex listener', evt)
      useSocket.registeredVuexListeners.push(evt)
    })
  },
  namespace({ ctx, namespaceCfg, socket, emitTimeout, emitErrorsProp }) {
    const { emitters = [], listeners = [], emitBacks = [] } = namespaceCfg
    const sets = { emitters, listeners, emitBacks }
    Object.entries(sets).forEach(([setName, entries]) => {
      if (entries.constructor.name === 'Array') {
        register[setName]({ ctx, socket, entries, emitTimeout, emitErrorsProp })
      } else {
        warn(
          `[nuxt-socket-io]: ${setName} needs to be an array in namespace config`
        )
      }
    })
  },
  vuexModule({ store }) {
    store.registerModule(
      '$nuxtSocket',
      {
        namespaced: true,
        state: {
          clientApis: {},
          ioApis: {},
          sockets: {},
          emitErrors: {},
          emitTimeouts: {}
        },
        mutations: {
          SET_API(state, { label, api }) {
            state.ioApis[label] = api
          },

          SET_CLIENT_API(state, { label = 'clientAPI', ...api }) {
            state.clientApis[label] = api
          },

          SET_SOCKET(state, { label, socket }) {
            state.sockets[label] = socket
          },

          SET_EMIT_ERRORS(state, { label, emitEvt, err }) {
            if (state.emitErrors[label] === undefined) {
              state.emitErrors[label] = {}
            }

            if (state.emitErrors[label][emitEvt] === undefined) {
              state.emitErrors[label][emitEvt] = []
            }

            state.emitErrors[label][emitEvt].push(err)
          },

          SET_EMIT_TIMEOUT(state, { label, emitTimeout }) {
            state.emitTimeouts[label] = emitTimeout
          }
        },
        actions: {
          emit(
            { state, commit },
            { label, socket, evt, msg, emitTimeout, noAck }
          ) {
            debug('$nuxtSocket vuex action "emit" dispatched', label, evt)
            return new Promise((resolve, reject) => {
              const _socket = socket || state.sockets[label]
              const _emitTimeout =
                emitTimeout !== undefined
                  ? emitTimeout
                  : state.emitTimeouts[label]

              if (_socket === undefined) {
                reject(
                  new Error(
                    'socket instance required. Please provide a valid socket label or socket instance'
                  )
                )
              }
              debug(`Emitting ${evt} with msg`, msg)
              let timer
              _socket.emit(evt, msg, (resp) => {
                debug('Emitter response rxd', { evt, resp })
                clearTimeout(timer)
                const { emitError, ...errorDetails } = resp || {}
                if (emitError !== undefined) {
                  const err = {
                    message: emitError,
                    emitEvt: evt,
                    errorDetails,
                    timestamp: Date.now()
                  }
                  debug('Emit error occurred', err)
                  if (label !== undefined && label !== '') {
                    debug(
                      `[nuxt-socket-io]: ${label} Emit error ${err.message} occurred and logged to vuex `,
                      err
                    )
                    commit('SET_EMIT_ERRORS', { label, emitEvt: evt, err })
                    resolve()
                  } else {
                    reject(new Error(JSON.stringify(err, null, '\t')))
                  }
                } else {
                  resolve(resp)
                }
              })

              if (noAck) {
                resolve()
              }

              if (_emitTimeout) {
                debug(`registering emitTimeout ${_emitTimeout} ms for ${evt}`)
                timer = setTimeout(() => {
                  const err = {
                    message: 'emitTimeout',
                    emitEvt: evt,
                    emitTimeout,
                    hint: [
                      `1) Is ${evt} supported on the backend?`,
                      `2) Is emitTimeout ${_emitTimeout} ms too small?`
                    ].join('\r\n'),
                    timestamp: Date.now()
                  }
                  if (label !== undefined && label !== '') {
                    commit('SET_EMIT_ERRORS', { label, emitEvt: evt, err })
                    debug(
                      `[nuxt-socket-io]: ${label} Emit error occurred and logged to vuex `,
                      err
                    )
                    resolve()
                  } else {
                    reject(new Error(JSON.stringify(err, null, '\t')))
                  }
                }, _emitTimeout)
              }
            })
          }
        }
      },
      { preserveState: false }
    )
  },
  vuexOpts({ ctx, vuexOpts, useSocket, socket, store }) {
    const { mutations = [], actions = [], emitBacks = [] } = vuexOpts
    const sets = { mutations, actions, emitBacks }
    const storeFns = {
      mutations: 'commit',
      actions: 'dispatch'
    }
    Object.entries(sets).forEach(([setName, entries]) => {
      if (entries.constructor.name === 'Array') {
        const fnName = storeFns[setName]
        if (fnName) {
          register.listenersVuex({
            ctx,
            socket,
            entries,
            storeFn: store[fnName],
            useSocket
          })
        } else {
          register.emitBacksVuex({ ctx, store, useSocket, socket, entries })
        }
      } else {
        warn(`[nuxt-socket-io]: vuexOption ${setName} needs to be an array`)
      }
    })
  },
  socketStatus({ ctx, socket, connectUrl, statusProp }) {
    const socketStatus = { connectUrl }
    const clientEvts = [
      'connect_error',
      'connect_timeout',
      'reconnect',
      'reconnect_attempt',
      'reconnecting',
      'reconnect_error',
      'reconnect_failed',
      'ping',
      'pong'
    ]
    clientEvts.forEach((evt) => {
      const prop = camelCase(evt)
      socketStatus[prop] = ''
      socket.on(evt, (resp) => {
        Object.assign(ctx[statusProp], { [prop]: resp })
      })
    })
    Object.assign(ctx, { [statusProp]: socketStatus })
  },
  teardown({ ctx, socket, useSocket }) {
    if (ctx.onComponentDestroy === undefined) {
      ctx.onComponentDestroy = ctx.$destroy
    }

    ctx.$on('closeSockets', function() {
      socket.removeAllListeners()
      socket.close()
    })

    if (!ctx.registeredTeardown) {
      debug('teardown enabled for socket', { name: useSocket.name })
      ctx.$destroy = function() {
        debug('component destroyed, closing socket(s)', {
          name: useSocket.name,
          url: useSocket.url
        })
        useSocket.registeredVuexListeners = []
        ctx.$emit('closeSockets')
        ctx.onComponentDestroy()
      }
      ctx.registeredTeardown = true
    }

    socket.on('disconnect', () => {
      debug('server disconnected', { name: useSocket.name, url: useSocket.url })
      socket.close()
    })
  }
}

function nuxtSocket(ioOpts) {
  const {
    name,
    channel = '',
    statusProp = 'socketStatus',
    persist,
    teardown = !persist,
    emitTimeout,
    emitErrorsProp = 'emitErrors',
    ioApiProp = 'ioApi',
    ioDataProp = 'ioData',
    apiIgnoreEvts = [],
    serverAPI,
    clientAPI,
    vuex,
    namespaceCfg,
    ...connectOpts
  } = ioOpts
  const pluginOptions = _pOptions.get()
  const { sockets, warnings = true } = pluginOptions
  const { $store: store } = this

  warn =
    warnings && process.env.NODE_ENV !== 'production' ? consola.warn : () => {}

  if (
    !sockets ||
    sockets.constructor.name !== 'Array' ||
    sockets.length === 0
  ) {
    throw new Error(
      "Please configure sockets if planning to use nuxt-socket-io: \r\n [{name: '', url: ''}]"
    )
  }

  let useSocket = null

  if (!name) {
    useSocket = sockets.find((s) => s.default === true)
  } else {
    useSocket = sockets.find((s) => s.name === name)
  }

  if (!useSocket) {
    useSocket = sockets[0]
  }

  if (!useSocket.name) {
    useSocket.name = 'dflt'
  }

  if (!useSocket.url) {
    warn(`URL not defined for socket "${useSocket.name}". Defaulting to "window.location"`)
  }

  if (!useSocket.registeredWatchers) {
    useSocket.registeredWatchers = []
  }

  if (!useSocket.registeredVuexListeners) {
    useSocket.registeredVuexListeners = []
  }

  let { url: connectUrl } = useSocket
  if (connectUrl) {
    connectUrl += channel
  }

  const vuexOpts = vuex || useSocket.vuex
  const { namespaces = {} } = useSocket

  let socket
  const label =
    persist && typeof persist === 'string'
      ? persist
      : `${useSocket.name}${channel}`

  if (!store.state.$nuxtSocket) {
    debug('vuex store $nuxtSocket does not exist....registering it')
    register.vuexModule({ store })
  }

  if (emitTimeout) {
    store.commit('$nuxtSocket/SET_EMIT_TIMEOUT', { label, emitTimeout })
  }

  function connectSocket() {
    if (connectUrl) {
      socket = io(connectUrl, connectOpts)
      consola.info('[nuxt-socket-io]: connect', useSocket.name, connectUrl)
    } else {
      socket = io(channel, connectOpts)
      consola.info('[nuxt-socket-io]: connect', useSocket.name, window.location, channel)
    }
  }

  if (persist) {
    if (store.state.$nuxtSocket.sockets[label]) {
      debug(`resuing persisted socket ${label}`)
      socket = store.state.$nuxtSocket.sockets[label]
      if (socket.disconnected) {
        debug('persisted socket disconnected, reconnecting...')
        connectSocket()
      }
    } else {
      debug(`socket ${label} does not exist, creating and connecting to it..`)
      connectSocket()
      store.commit('$nuxtSocket/SET_SOCKET', { label, socket })
    }
  } else {
    connectSocket()
  }

  const _namespaceCfg = namespaceCfg || namespaces[channel]
  if (_namespaceCfg) {
    register.namespace({
      ctx: this,
      namespace: channel,
      namespaceCfg: _namespaceCfg,
      socket,
      useSocket,
      emitTimeout,
      emitErrorsProp
    })
    debug('namespaces configured for socket', {
      name: useSocket.name,
      channel,
      namespaceCfg
    })
  }

  if (serverAPI) {
    register.serverAPI({
      store,
      label,
      apiIgnoreEvts,
      ioApiProp,
      ioDataProp,
      ctx: this,
      socket,
      emitTimeout,
      emitErrorsProp,
      serverAPI,
      clientAPI
    })
  }

  if (clientAPI) {
    register.clientAPI({
      ctx: this,
      store,
      socket,
      clientAPI
    })
  }

  if (vuexOpts) {
    register.vuexOpts({
      ctx: this,
      vuexOpts,
      useSocket,
      socket,
      store
    })
    debug('vuexOpts configured for socket', { name: useSocket.name, vuexOpts })
  }

  if (
    this.socketStatus !== undefined &&
    typeof this.socketStatus === 'object'
  ) {
    register.socketStatus({ ctx: this, socket, connectUrl, statusProp })
    debug('socketStatus registered for socket', {
      name: useSocket.name,
      url: connectUrl
    })
  }

  if (teardown) {
    register.teardown({
      ctx: this,
      socket,
      useSocket
    })
  }
  _pOptions.set({ sockets })
  return socket
}

export default function(context, inject) {
  inject('nuxtSocket', nuxtSocket)
}

export let pOptions
if (process.env.TEST) {
  pOptions = {}
  Object.assign(pOptions, _pOptions)
}
