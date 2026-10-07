import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/main.css'
import App from './App.vue'
import router from './router'
import { initDatabase } from './utils/db'

/** 先打开本地库并播种演示数据，保证首屏每个页面打开都有内容 */
async function bootstrap(): Promise<void> {
  try {
    await initDatabase()
  } catch (error) {
    // 本地库不可用时仍然渲染界面，页面内会给出可读的错误提示
    console.error('本地数据库初始化失败', error)
  }
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.use(ElementPlus)
  app.mount('#app')
}

void bootstrap()
