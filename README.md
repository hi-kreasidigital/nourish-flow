# Nourish & Flow Bali: Website

Website statis (cepat, SEO-friendly) dengan konten yang dikelola lewat **Airtable**, di-host di **GitHub Pages** dengan **domain sendiri**. Tidak ada server, tidak ada layanan lain.

```
Airtable (edit konten) ──► GitHub Actions (build) ──► GitHub Pages ──► nourishflowbali.com
```

Setiap kali konten Airtable berubah, website dibangun ulang otomatis (±1–2 menit). Tanpa menu Blog.

## Struktur halaman

| URL | Isi |
|---|---|
| `/` | Home: hero, offerings, upcoming events, galeri, Instagram Reels |
| `/about/` | Our Philosophy, Nasya + Citra |
| `/for-your-body/` + `/for-your-body/<slug>/` | Pole Dance Classes, Performance, Pilates |
| `/for-your-plate/` + `/for-your-plate/<slug>/` | Weekly Meals, Recipes, Workshops |
| `/book-and-shop/` | Booking, produk fisik |
| `/connect/` | Kontak, form, peta, Reels |

Otomatis dibuat: `sitemap.xml`, `robots.txt`, `404.html`, canonical, Open Graph, JSON-LD (LocalBusiness, Service, Product, Event, Breadcrumb), gambar WebP responsif.

## 1. Setup Airtable

Buat base baru (mis. "Nourish & Flow CMS") dengan 7 tabel. Nama tabel dan field harus **persis** seperti di bawah (huruf besar-kecil tidak masalah untuk field).

**Aturan umum:** hanya baris dengan centang **Published** yang tampil di website (kecuali tabel Settings). Kolom **Order** mengatur urutan.

### Settings (teks & pengaturan global)
Field: `Key` (single line text), `Value` (long text), `Image` (attachment).
Isi satu baris per pengaturan. Nilai default semuanya sudah ada di `data/seed.json` → hanya tambahkan baris yang ingin Anda ubah. Yang **wajib diisi** dulu:

| Key | Contoh |
|---|---|
| `whatsappNumber` | `6281234567890` (format internasional, tanpa + / spasi) |
| `instagramUrl` | `https://instagram.com/nourishflowbali` |
| `street` | alamat studio |
| `bookingFormUrl` | link embed Airtable Form (lihat bawah) |
| `contactFormUrl` | link embed Airtable Form kontak |
| `mapEmbedUrl` | URL embed Google Maps (opsional) |
| `heroImage` | isi kolom **Image** (upload foto), bukan Value |
| `pleasureImage` | idem |

Key lain yang bisa diubah: `heroTitle`, `heroText`, `pleasureTitle`, `pleasureText`, `offeringsTitle`, `eventsTitle`, `bandTitle`, `marquee`, `ctaTitle`, `aboutText`, `bodyIntro`, `plateIntro`, `shopIntro`, `connectIntro`, `seo…Title`, `seo…Description`, dll. (lihat daftar lengkap di `data/seed.json`).

### Services
`Name`, `Slug`, `Category` (single select: **Body** / **Plate**), `Short Description`, `Description` (long text; baris kosong = paragraf baru), `Price` (number, IDR), `Price Note` (mis. "per class", "starting from", "Custom quote"), `Level`, `Duration`, `Instructor`, `Image`, `CTA Label`, `CTA Type` (single select: **WhatsApp** / **Link** / **Form**), `CTA URL` (untuk tipe Link, mis. link pembayaran), `SEO Title`, `SEO Description`, `Featured` (tampil di Home, pilih 3), `Order`, `Published`.

### Events (Upcoming Energy)
`Title`, `Type`, `Description`, `Date` (date; kosong = "Dates announced soon"), `Location`, `Price`, `Image`, `CTA Label`, `CTA Type`, `CTA URL`, `Order`, `Published`.
Event yang tanggalnya sudah lewat otomatis disembunyikan saat rebuild.

### Products (produk fisik)
`Name`, `Slug`, `Description`, `Price`, `Image`, `Order URL` (link pembayaran, mis. Stripe/Xendit/Midtrans Payment Link; kosong = order via WhatsApp), `Sold Out` (checkbox), `Order`, `Published`.

### Reels (Instagram)
`Title`, `URL` (link reel/post Instagram), `Order`, `Published`.

### Team
`Name`, `Role`, `Bio`, `Photo`, `Order`, `Published`.

### Gallery (mozaik di Home)
`Caption`, `Image`, `Order`, `Published`.

### Form booking / kontak
Di Airtable buat **Form view** pada tabel baru (mis. `Bookings`, `Enquiries`) → Share form → salin link → tempel ke Settings (`bookingFormUrl`, `contactFormUrl`). Untuk kontak, buat field Subject (dropdown: General Enquiry / Book a Class / Meal Plan / Performance Booking / Workshop) sesuai dokumen konten.

## 2. Token Airtable
1. https://airtable.com/create/tokens → **Create token**
2. Scope: `data.records:read`
3. Access: pilih base CMS ini saja
4. Salin token (`pat…`) dan **Base ID** (`app…`, ada di URL base / halaman API docs).

## 3. GitHub
1. Buat repo baru, push folder ini ke branch `main`.
2. **Settings → Secrets and variables → Actions → New repository secret**: `AIRTABLE_TOKEN` dan `AIRTABLE_BASE_ID`.
3. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Jalankan workflow **Build & Deploy** (Actions → Run workflow). Website akan online di `https://<user>.github.io/<repo>/` sebelum domain dipasang.

## 4. Domain (nourishflowbali.com)
Di DNS registrar:

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `<user>.github.io` |

Lalu **Settings → Pages → Custom domain** → isi domain → centang **Enforce HTTPS** (tunggu sertifikat ±15 menit). File `CNAME` sudah dibuat otomatis oleh build dari `siteUrl`. Jika domain bukan `nourishflowbali.com`, ubah key `siteUrl` di Settings (atau variabel `SITE_URL`).

## 5. Rebuild otomatis saat Airtable berubah
Workflow juga jalan setiap 6 jam sebagai cadangan. Untuk update instan:

1. GitHub → Settings → Developer settings → **Fine-grained token** untuk repo ini, izin **Contents: Read and write** (dipakai untuk `repository_dispatch`). Simpan sebagai secret `GITHUB_TOKEN` di Airtable Automation.
2. Airtable → **Automations** → buat automation: trigger **When record updated** (atau created) pada tabel Services/Events/Products/Settings/dst. (satu automation per tabel, atau satu untuk tiap tabel penting).
3. Action **Run script**, tambahkan input secret `token`, lalu:

```js
const token = input.secret('token');
const res = await fetch('https://api.github.com/repos/OWNER/REPO/dispatches', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ event_type: 'airtable-update' }),
});
if (!res.ok) throw new Error(await res.text());
```
Ganti `OWNER/REPO`.

## Development lokal
```bash
npm install
cp .env.example .env      # isi token, lalu: export $(cat .env | xargs)
npm run build             # tanpa token memakai data/seed.json
npm run preview
```

## Catatan
- **Gambar**: unggah foto di Airtable. Build mengunduh, mengubah ke WebP (640/1280/1920px) dan menyimpannya di situs, sehingga link Airtable yang kedaluwarsa tidak jadi masalah. Foto landscape ≥ 1600px, isi alt lewat key `heroImageAlt` / `pleasureImageAlt`.
- **Pembayaran & booking**: tanpa server, jadi booking lewat WhatsApp (pesan sudah terisi otomatis) atau Airtable Form; produk lewat WhatsApp atau Payment Link.
- **Warna brand**: `--coral #FF8F77`, `--ink #0B0B0B`, putih. Ubah di bagian atas `src/styles.css`.
- Teks coral di atas putih hanya dipakai untuk judul besar (kontras aman untuk teks besar). Tombol memakai teks hitam di atas coral.
