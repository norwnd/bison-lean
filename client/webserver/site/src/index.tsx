import { createRoot } from 'react-dom/client'
import App from './App'
import './css/bootstrap.scss'
import './css/application.scss'

const container = document.getElementById('root')
if (container) {
  const root = createRoot(container)
  root.render(<App />)
}
