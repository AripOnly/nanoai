# Issue: Pembersihan Terminal, Render Ulang Banner, dan Isolasi Sesi Baru

## 1. Ringkasan Kebutuhan
Setiap kali pengguna melakukan pergantian sesi (`/session`) maupun membuat sesi baru (`/new`):
1. Seluruh tampilan terminal (termasuk banner awal, riwayat percakapan sesi lama, dan scrollback terminal) harus dibersihkan secara tuntas.
2. Banner NanoAI dimunculkan kembali di posisi paling atas layar.
3. Sesi yang baru langsung ditampilkan:
   - Jika membuat sesi baru (`/new`): Tampilkan banner diikuti area input prompt yang bersih.
   - Jika berpindah ke sesi yang sudah ada (`/session`): Tampilkan banner diikuti seluruh riwayat percakapan dari sesi yang dipilih, lalu area input prompt di bagian bawah.

---

## 2. Analisis Kondisi Saat Ini (Root Cause Analysis)

1. **Banner Dicetak Hanya Sekali Sebelum Ink Berjalan (`main.jsx`)**:
   Saat ini, banner dicetak menggunakan `console.log()` biasa di luar siklus hidup React/Ink sebelum `render(<App />)` dipanggil. Ketika `console.clear()` dijalankan saat ganti sesi, banner terhapus permanen dan tidak pernah bisa muncul kembali.

2. **Pembersihan Terminal Parsial**:
   Pemanggilan `console.clear()` standar Node.js di Windows sering kali hanya membersihkan viewport yang terlihat, tetapi tidak menghapus buffer scrollback (`\x1B[3J`). Akibatnya, saat pengguna melakukan scroll ke atas, riwayat sesi lama masih tertinggal.

3. **Keying `<Static>` Menggunakan `activeSession?.id ?? "new"`**:
   Ketika sesi baru dimulai, `activeSession` awalnya bernilai `null` (`key="new"`). Begitu prompt pertama dikirim, backend membuat sesi baru dan `activeSession.id` berubah menjadi ID sesi. Perubahan key ini menyebabkan `<Static>` unmount dan me-remount tanpa pembersihan terminal, yang berpotensi menduplikasi output di tengah sesi.

---

## 3. Rencana Arsitektur & Solusi Teknis

### A. Utilitas Pembersihan Layar Total (`clearTerminal`)
Membuat fungsi pembersih terminal yang mengirim kode ANSI escape sequence standar:
* `\x1B[2J` : Bersihkan seluruh layar viewport terminal.
* `\x1B[3J` : Bersihkan seluruh buffer scrollback terminal (agar sesi lama tidak tersisa saat di-scroll ke atas).
* `\x1B[H`  : Pindahkan kursor ke posisi awal (baris 1, kolom 1).

### B. Komponen Banner Terdedikasi (`Banner.jsx`)
Membuat komponen `<Banner />` di `apps/cli/components/Banner.jsx` menggunakan styling Ink (warna oranye cerah `#FFA500` / aksen NanoAI). Banner ini menjadi bagian resmi dari hierarki komponen React/Ink sehingga dapat dirender ulang secara dinamis kapan pun layar sesi di-reset.

### C. State Manajemen `viewKey` (Discrete Session Epoch)
Menambahkan state `viewKey` (counter integer unik) di `useChat.js`:
* `viewKey` hanya bertambah ketika pengguna **secara eksplisit** memicu:
  1. `newSession()`
  2. `switchSession(sessionId)`
* Selama percakapan berlangsung dalam sesi yang sama (termasuk saat sesi baru pertama kali mendapatkan `id`), `viewKey` tidak berubah sehingga `<Static key={viewKey}>` tidak mengalami remount yang tidak diinginkan.

### D. Struktur Render `<Static>` di `App.jsx`
Menggabungkan `<Banner />` ke dalam item pertama `<Static>` untuk setiap epoch sesi:
```jsx
const sessionItems = useMemo(() => [
  <Banner key={`banner-${viewKey}`} />,
  ...conversationItems
], [viewKey, conversationItems]);

<Static key={viewKey} items={sessionItems}>
  {(el) => el}
</Static>
```
Dengan struktur ini:
* Setiap pergantian sesi atau sesi baru: Terminal dibersihkan total -> `<Static key={viewKey}>` baru dipasang -> Banner dicetak di paling atas -> Riwayat sesi baru (jika ada) dicetak di bawah banner -> Input prompt aktif berada di bawahnya.

---

## 4. Langkah-Langkah Pengerjaan (Action Plan)

1. **Langkah 1**: Buat komponen `apps/cli/components/Banner.jsx` yang membaca dan merender teks banner dari `banner.txt` dengan styling Ink yang konsisten.
2. **Langkah 2**: Buat fungsi `clearTerminal()` di `apps/cli/lib/terminal.js` (atau helper utilitas CLI) yang menangani escape sequence ANSI pembersih layar dan scrollback.
3. **Langkah 3**: Perbarui `apps/cli/hooks/useChat.js`:
   - Tambahkan state `viewKey` dan ekspos ke komponen pemanggil.
   - Panggil `clearTerminal()` dan inkrementasi `viewKey` pada handler `newSession()` dan `switchSession()`.
4. **Langkah 4**: Perbarui `apps/cli/App.jsx`:
   - Gunakan `viewKey` sebagai key utama container `<Static>`.
   - Sertakan `<Banner />` di posisi teratas daftar item `<Static>`.
5. **Langkah 5**: Sesuaikan `apps/cli/main.jsx`:
   - Hapus pemanggilan awal `console.log(banner)` sebelum `render(<App />)` karena banner kini dikelola secara otomatis oleh komponen React/Ink.
6. **Langkah 6**: Validasi dan Pengujian:
   - Jalankan verifikasi sintaks dan pengujian unit (`npm test`).
   - Uji alur `/new` dan `/session` untuk memastikan layar bersih total dan banner selalu muncul di atas sesi baru.

---

## 5. Kriteria Penerimaan (Acceptance Criteria)
- [x] Menjalankan `/new` membersihkan seluruh layar dan scrollback terminal, lalu mencetak banner Nano dan input prompt baru.
- [x] Menjalankan `/session` dan memilih sesi lain membersihkan seluruh layar dan scrollback sesi sebelumnya, lalu mencetak banner Nano diikuti riwayat percakapan sesi terpilih.
- [x] Tidak terjadi duplikasi pencetakan banner atau riwayat percakapan saat mengirim pesan pertama pada sesi baru.
- [x] Seluruh unit test (`npm test`) tetap lulus 100%.
