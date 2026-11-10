import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const BUNDLE_ID = 'mindseb'
export const VERSION = '0.1.0'
export const PACKAGE_ROOT = path.resolve(__dirname, '..')
