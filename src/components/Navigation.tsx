import { useRef, useState, useEffect } from "react";
import localforage from "localforage";
import ePub from "epubjs";
import { bufferToBase64, base64ToBuffer } from "../utils/backup";
import {
  uploadToDropbox,
  downloadFromDropbox,
  getAccessToken,
  startDropboxAuth,
} from "../utils/dropbox";
import type { Book } from "../App";

function Navigation({ setBooks }: { setBooks: Function }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const [isToCloudLoading, setIsToCloudLoading] = useState(false);
  const [isFromCloudLoading, setIsFromCloudLoading] = useState(false);
  const [isLoggedInDropbox, setIsLoggedInDropbox] = useState(false);

  useEffect(() => {
    if (getAccessToken()) setIsLoggedInDropbox(true);
  }, []);

  const gatherAllData = async () => {
    const keys = await localforage.keys();
    const fullData: Record<string, any> = {};
    for (const key of keys) {
      const value = await localforage.getItem(key);
      if (key.startsWith("book-") && value && typeof value === "object") {
        const bookValue = value as any;
        fullData[key] = { ...bookValue, data: bufferToBase64(bookValue.data) };
      } else {
        fullData[key] = value;
      }
    }
    return fullData;
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files;
    if (!files) return;
    const newBooks: Book[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.name.toLowerCase().endsWith(".epub")) continue;
      const bookId = `book-${file.name}-${file.size}-${file.lastModified}`;
      const existingBook = await localforage.getItem(bookId);
      if (existingBook) continue;
      try {
        const arrayBuffer = await file.arrayBuffer();
        const book = await ePub(arrayBuffer);
        const coverUrl = await book.coverUrl();
        let permanentCover = "";
        if (coverUrl) {
          const response = await fetch(coverUrl);
          const blob = await response.blob();
          permanentCover = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          URL.revokeObjectURL(coverUrl);
        }
        const newBookObj: Book = {
          id: bookId,
          name: file.name,
          cover: permanentCover || "",
          data: arrayBuffer,
        };
        await localforage.setItem(bookId, newBookObj);
        newBooks.push(newBookObj);
      } catch (error) {
        console.error(error);
      }
    }
    if (newBooks.length > 0) setBooks((prev: Book[]) => [...prev, ...newBooks]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  };

  const handleLocalExport = async () => {
    const data = await gatherAllData();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `reader-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleLocalRestore = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        await localforage.clear();
        for (const [key, value] of Object.entries(json)) {
          let dataToSave = value;
          if (key.startsWith("book-") && value && typeof value === "object") {
            const bookValue = value as any;
            dataToSave = { ...bookValue, data: base64ToBuffer(bookValue.data) };
          }
          await localforage.setItem(key, dataToSave);
        }
        window.location.reload();
      } catch (err) {
        alert("Restore failed");
      }
    };
    reader.readAsText(file);
  };

  const handleSyncToCloud = async () => {
    setIsToCloudLoading(true);
    const data = await gatherAllData();
    const success = await uploadToDropbox(data);
    setIsToCloudLoading(false);
    if (success) alert("Saved to Cloud!");
  };

  const handleSyncFromCloud = async () => {
    if (!confirm("Overwrite current library with Cloud data?")) return;
    setIsFromCloudLoading(true);
    const json = await downloadFromDropbox();
    if (json) {
      await localforage.clear();
      for (const [key, value] of Object.entries(json)) {
        let dataToSave = value;
        if (key.startsWith("book-") && value && typeof value === "object") {
          const bookValue = value as any;
          dataToSave = { ...bookValue, data: base64ToBuffer(bookValue.data) };
        }
        await localforage.setItem(key, dataToSave);
      }
      window.location.reload();
    } else {
      alert("Cloud backup not found.");
    }
    setIsFromCloudLoading(false);
  };

  return (
    <nav className="ma2 br3 ba bw1 navBorderColor bg-[#1c1c1c] flex flex-wrap lg:flex-nowrap items-center justify-center lg:justify-between p-2 md:ph4 md:pv2 gap-4 shadow-lg">
      {/* HIDDEN INPUTS */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={handleFileChange}
        multiple
        accept=".epub"
      />
      <input
        type="file"
        ref={folderInputRef}
        style={{ display: "none" }}
        onChange={handleFileChange}
        {...({ webkitdirectory: "", directory: "" } as any)}
        multiple
      />
      <input
        type="file"
        ref={restoreInputRef}
        style={{ display: "none" }}
        onChange={handleLocalRestore}
        accept=".json"
      />

      {/* LEFT GROUP: Library Management */}
      <div className="flex items-center justify-center gap-2 w-full sm:w-auto">
        <button
          className="flex-1 sm:flex-none text-gray-200 bg-white/5 hover:bg-white/10 bn pointer pv2 ph3 br2 transition-all flex items-center justify-center gap-2 text-sm font-medium whitespace-nowrap"
          onClick={() => fileInputRef.current?.click()}
        >
          <span>📖</span> <span className="dn di-m di-l">Import</span> Books
        </button>
        <button
          className="flex-1 sm:flex-none text-gray-200 bg-white/5 hover:bg-white/10 bn pointer pv2 ph3 br2 transition-all flex items-center justify-center gap-2 text-sm font-medium whitespace-nowrap"
          onClick={() => folderInputRef.current?.click()}
        >
          <span>📁</span> <span className="dn di-m di-l">Import</span> Folder
        </button>
      </div>

      {/* RIGHT GROUP: Sync & Backup */}
      <div className="flex flex-wrap items-center justify-center gap-3 w-full lg:w-auto">
        {/* Dropbox Interface */}
        <div className="flex items-center justify-center gap-2 w-full sm:w-auto">
          {!isLoggedInDropbox ? (
            <button
              className="flex-1 sm:flex-none bg-indigo-700 hover:bg-indigo-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight whitespace-nowrap"
              onClick={startDropboxAuth}
            >
              🔗 Connect Dropbox
            </button>
          ) : (
            <div className="flex items-center justify-center gap-2 w-full sm:w-auto">
              <button
                disabled={isToCloudLoading || isFromCloudLoading}
                className="flex-1 sm:flex-none bg-indigo-700 hover:bg-indigo-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight min-w-[120px] whitespace-nowrap"
                onClick={handleSyncToCloud}
              >
                {isToCloudLoading ? "⏳..." : "☁️ Sync To Cloud"}
              </button>
              <button
                disabled={isToCloudLoading || isFromCloudLoading}
                className="flex-1 sm:flex-none bg-teal-700 hover:bg-teal-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight min-w-[140px] whitespace-nowrap"
                onClick={handleSyncFromCloud}
              >
                {isFromCloudLoading ? "⏳..." : "☁️ Sync From Cloud"}
              </button>
            </div>
          )}
        </div>

        {/* Vertical Divider (Visible ONLY on large desktop screens so it stays out of the way on tablet wraps) */}
        <div className="hidden lg:block bl bw1 h1 mh1 border-white-10 navBorderColor"></div>

        {/* Local Interface */}
        <div className="flex items-center justify-center gap-2 w-full sm:w-auto border-t border-white/5 pt-3 sm:pt-0 sm:border-t-0">
          <button
            className="flex-1 sm:flex-none bg-blue-700 hover:bg-blue-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight whitespace-nowrap"
            onClick={handleLocalExport}
          >
            📤 Export
          </button>
          <button
            className="flex-1 sm:flex-none bg-red-800 hover:bg-red-700 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight whitespace-nowrap"
            onClick={() => restoreInputRef.current?.click()}
          >
            📥 Restore
          </button>
        </div>
      </div>
    </nav>
  );
}

export default Navigation;
