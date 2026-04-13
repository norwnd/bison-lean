import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import './i18n'

export default function App () {
  return <RouterProvider router={router} />
}
