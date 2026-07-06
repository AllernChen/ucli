import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// electron-vite builds three targets:
//   main     -> out/main/index.js   (Node/Electron main process, bundled CJS)
//   preload  -> out/preload/index.js (contextBridge, bundled CJS)
//   renderer -> out/renderer/        (Vue 3 SPA, Vite ESM)
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main.js') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload.js') }
      }
    }
  },
  renderer: {
    root: resolve('src'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/index.html') }
      }
    },
    resolve: {
      alias: { '@': resolve('src') }
    },
    plugins: [vue()]
  }
})
