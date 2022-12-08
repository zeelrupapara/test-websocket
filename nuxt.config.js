module.exports = {
  mode: 'universal',
  /*
   ** Headers of the page
   */
  head: {
    title: process.env.npm_package_name || '',
    meta: [
      { charset: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      {
        hid: 'description',
        name: 'description',
        content: process.env.npm_package_description || ''
      }
    ],
    link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }]
  },
  /*
   ** Customize the progress-bar color
   */
  loading: { color: '#fff' },
  /*
   ** Global CSS
   */
  css: ['~/assets/main.css'],
  /*
   ** Plugins to load before mounting the App
   */
  plugins: [],
  /*
   ** Nuxt.js dev-modules
   */
  buildModules: [
    // Doc: https://github.com/nuxt-community/eslint-module
    '@nuxtjs/eslint-module'
  ],
  /*
   ** Nuxt.js modules
   */
  modules: [
    // Doc: https://bootstrap-vue.js.org
    'bootstrap-vue/nuxt',
    '~/io/module'
  ],
  io: {
    sockets: [
      {
        name: 'heroku',
        url: 'https://nuxt-socket-io-server.herokuapp.com',
        default: true,
        namespaces: {
          '/rooms': {
            emitters: ['getRooms --> rooms']
          },
          '/room': {
            emitters: [
              'joinRoom + joinMsg --> roomInfo',
              'leaveRoom + leaveMsg'
            ],
            listeners: ['joinedRoom [updateUsers', 'leftRoom [updateUsers']
          },
          '/channel': {
            emitters: [
              'joinChannel + joinMsg --> channelInfo',
              'leaveChannel + leaveMsg',
              'sendMsg + userMsg --> msgRxd [appendChats'
            ],
            listeners: [
              'joinedChannel [updateChannelInfo',
              'leftChannel [updateChannelInfo',
              'chatMessage [appendChats'
            ]
          }
        }
      }
    ]
  },
  /*
   ** Build configuration
   */
  build: {
    /*
     ** You can extend webpack config here
     */
    extend(config, ctx) {},
    parallel: false,
    cache: false,
    hardSource: false
  },
  globals: {
    loadingTimeout: 5000
  },
  generate: {
    dir: '/tmp/netlify/nuxt-socket-io-standalone'
  }
}
