import { createContext, useContext } from 'solid-js'
import type { CanvasController } from './controller.ts'

/** 本页的控制器，由 `CanvasPanel` 提供。 */
export const CanvasContext = createContext<CanvasController>()

/** 画布区内的组件取得本页的控制器。只能在 `CanvasContext.Provider` 之内调用。 */
export const useCanvas = (): CanvasController => useContext(CanvasContext)!
