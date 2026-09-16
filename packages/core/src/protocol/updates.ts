/** 应用进程所有者发布的更新快照。 */
export interface UpdateSnapshot {
  mode: 'installed' | 'source-desktop' | 'source-web' | 'manual'
  currentVersion: string
  stage:
    | 'idle'
    | 'checking'
    | 'latest'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'waiting'
    | 'installing'
    | 'error'
  version: string | null
  notes: string
  progress: number | null
  checkedAt: number | null
  error: string | null
  retry: 'check' | 'download' | 'install'
}

export type UpdateAction = 'status' | 'check' | 'download' | 'install' | 'cancel'

export interface UpdatePreferences {
  autoCheck: boolean
  autoDownload: boolean
}
