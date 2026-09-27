import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The phone's side of an update from a fork's GitHub releases: the APK comes through
// CapacitorHttp (GitHub's downloads carry no CORS headers), is checked against the SHA-256,
// and only then written and handed to the installer.
const mocks = vi.hoisted(() => ({ get: vi.fn(), writeFile: vi.fn(), installApk: vi.fn() }))
vi.mock('./mobile.js', () => ({ MOBILE: true }))
vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { get: mocks.get },
  registerPlugin: () => ({ installApk: mocks.installApk }),
}))
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: mocks.writeFile },
  Directory: { Cache: 'CACHE' },
}))

import { downloadAndInstall, sha256 } from './update.js'

const APK = new Uint8Array(150_000).map((_, i) => (i * 31) % 256)
const toBase64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
// Android's Base64.DEFAULT, as CapacitorHttp returns a blob: wrapped every 76 characters.
const wrapped = toBase64(APK).replace(/.{76}/g, '$&\n')

describe('downloadAndInstall from a GitHub release', () => {
  let originalFetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('the WebView may not fetch this')))
    vi.stubEnv('VITE_UPDATE_GITHUB_REPO', 'someone/open-gym')
    mocks.get.mockReset().mockResolvedValue({ status: 200, data: wrapped })
    mocks.writeFile.mockReset().mockResolvedValue({})
    mocks.installApk.mockReset().mockResolvedValue({})
  })
  afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllEnvs() })

  const URL = 'https://github.com/someone/open-gym/releases/download/v1.3.8-fork.1/openGym-1.3.8-fork.1.apk'

  it('downloads natively, checks the SHA-256, then writes and installs the file', async () => {
    const progress = vi.fn()
    await downloadAndInstall(URL, await sha256(APK.buffer), progress)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ url: URL, responseType: 'blob' }))
    expect(mocks.writeFile).toHaveBeenCalledWith({ path: 'opengym-update.apk', directory: 'CACHE', data: toBase64(APK) })
    expect(mocks.installApk).toHaveBeenCalledWith({ fileName: 'opengym-update.apk' })
    expect(progress).toHaveBeenLastCalledWith(APK.length, APK.length)
  })

  it('installs nothing when the checksum does not match', async () => {
    await expect(downloadAndInstall(URL, '0'.repeat(64))).rejects.toThrow('SHA-256 mismatch')
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.installApk).not.toHaveBeenCalled()
  })

  it('installs nothing when the download fails', async () => {
    mocks.get.mockResolvedValue({ status: 404, data: 'Not Found' })
    await expect(downloadAndInstall(URL, await sha256(APK.buffer))).rejects.toThrow('Download failed: 404')
    expect(mocks.installApk).not.toHaveBeenCalled()
  })

  it('installs nothing that is too small to be an APK', async () => {
    mocks.get.mockResolvedValue({ status: 200, data: toBase64(new Uint8Array(500)) })
    await expect(downloadAndInstall(URL, null)).rejects.toThrow('too small')
    expect(mocks.installApk).not.toHaveBeenCalled()
  })
})
