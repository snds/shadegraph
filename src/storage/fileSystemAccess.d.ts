// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — File System Access API ambient augmentation
// ───────────────────────────────────────────────────────────────────────────
// TypeScript's bundled `lib.dom.d.ts` declares `FileSystemDirectoryHandle`/
// `FileSystemFileHandle`/`FileSystemHandle` shells but is missing the async
// iteration (`values`/`entries`/`keys`), permission (`queryPermission`/
// `requestPermission`), and `Window.showDirectoryPicker` members the File
// System Access API (still WICG, not yet folded into the DOM spec proper)
// actually ships. This file only adds what's missing; it never redeclares
// what `lib.dom.d.ts` already has.
// ═══════════════════════════════════════════════════════════════════════════

export {};

declare global {
  type FileSystemPermissionMode = 'read' | 'readwrite';

  interface FileSystemHandlePermissionDescriptor {
    mode?: FileSystemPermissionMode;
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
    entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
    keys(): AsyncIterableIterator<string>;
  }

  interface DirectoryPickerOptions {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?:
      | 'desktop'
      | 'documents'
      | 'downloads'
      | 'music'
      | 'pictures'
      | 'videos'
      | FileSystemHandle;
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
