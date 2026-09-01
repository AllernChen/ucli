import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Antd from 'ant-design-vue'
import { message } from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import App from './App.vue'
import router from './router.js'
import './styles.css'

message.config({ duration: 3, top: '60px' })

const app = createApp(App)
if (import.meta.env.DEV) {
  const logRendererFailure = (kind, error, info = '', instance = null) => {
    const name = ['Error', 'TypeError', 'ReferenceError', 'RangeError'].includes(error?.name)
      ? error.name
      : 'Error'
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : null
    const rawMessage = typeof error?.message === 'string' ? error.message : ''
    const message = /^(?:Cannot read properties of (?:undefined|null) \(reading '[A-Za-z0-9_$-]+'\)|[A-Za-z0-9_$.-]+ is not a function)$/u.test(rawMessage)
      ? rawMessage
      : ''
    const frames = [...String(error?.stack || '').matchAll(/src\/[A-Za-z0-9_./-]+\.(?:vue|js):\d+:\d+/gu)]
      .slice(0, 4)
      .map((match) => match[0])
    const component = typeof instance?.$options?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(instance.$options.name)
      ? instance.$options.name
      : null
    void window.ucli?.log('error', 'renderer-failure', {
      kind, name, code, component, info: String(info).slice(0, 120), message, frames
    })
  }
  app.config.errorHandler = (error, instance, info) => logRendererFailure('vue', error, info, instance)
  window.addEventListener('error', (event) => logRendererFailure('window', event.error))
  window.addEventListener('unhandledrejection', (event) => logRendererFailure('promise', event.reason))
}
app.use(createPinia())
app.use(router)
app.use(Antd)
app.mount('#app')
