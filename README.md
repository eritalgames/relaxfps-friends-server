# RELAXFPS Server + Web Admin Studio v6

Bu sürümde yönetici/editör paneli kullanıcı uygulamasından çıkarılmış ve sunucunun içinde çalışan ayrı bir web paneline taşınmıştır.

## Admin Studio adresi

Render dağıtımı tamamlandıktan sonra:

```text
https://relaxfps-friends-server.onrender.com/admin
```

## Zorunlu Render ortam değişkenleri

```text
RELAXFPS_ADMIN_PASSWORD=<uzun ve benzersiz parola>
RELAXFPS_ADMIN_SESSION_SECRET=<en az 32 karakter rastgele gizli değer>
```

`RELAXFPS_ADMIN_PASSWORD` en az 12 karakter değilse web admin girişi tamamen kapalı kalır. Kod içinde yedek parola yoktur.

## İsteğe bağlı Authenticator / TOTP

Daha güçlü güvenlik için Base32 TOTP secret eklenebilir:

```text
RELAXFPS_ADMIN_TOTP_SECRET=<BASE32_SECRET>
```

Bu değişken tanımlandığında giriş ekranı hem parola hem de 6 haneli Authenticator kodu ister. Secret değerini Google Authenticator, Microsoft Authenticator, 2FAS veya Aegis gibi bir uygulamaya ekleyebilirsin.

Yeni bir secret ve Authenticator bağlantısı üretmek için:

```bash
npm run generate:totp -- admin@relaxfps
```

## Giriş sınırlandırması

Varsayılan değerler:

```text
RELAXFPS_ADMIN_LOGIN_MAX_ATTEMPTS=5
RELAXFPS_ADMIN_LOGIN_BLOCK_MINUTES=15
```

Bir IP çok sayıda hatalı giriş yaparsa geçici olarak engellenir. Başarılı girişten sonra kısa ömürlü, imzalı ve bellekte tutulan bir admin oturumu oluşturulur. Sunucu yeniden başlarsa bütün admin oturumları geçersiz olur.

## Web panel özellikleri

- Canlı sunucu özeti ve analiz
- Duyuru oluşturma/düzenleme/silme
- Duyuru görseli ve kısa video yükleme
- Özel içerik panelleri
- Promosyon ve referans kodları
- Kullanıcı arama
- Premium verme/kaldırma
- Ban verme/kaldırma
- Test kullanıcısı ve özel yönetici notu
- Tek kullanıcıya geliştirici mesajı
- Bakım modu ve zorunlu güncelleme
- Özellikleri uzaktan açma/kapatma
- Geri bildirim yanıtlama
- Hata raporları, audit log ve yedekleme
- Admin oturum süresi ayarı

## Güvenlik değişiklikleri

- Admin parolası WebSocket mesajıyla kabul edilmez.
- `admin_login` komutu devre dışıdır.
- Önce `/admin/api/login` üzerinden parola/TOTP doğrulanır.
- Tarayıcıya kısa ömürlü imzalı token verilir.
- WebSocket admin komutları `admin_auth` ile token doğrulaması yaptıktan sonra açılır.
- Her admin komutunda oturumun süresi tekrar kontrol edilir.
- Güvenlik başlıkları ve sıkı Content Security Policy uygulanır.
- Admin token yalnız tarayıcı `sessionStorage` alanında tutulur; sekme kapanınca silinir.
- Kod içine gömülü admin parolası kaldırılmıştır.

## Dosya yapısı

```text
server.js
package.json
README.md
admin/
  index.html
  styles.css
  app.js
  favicon.svg
```

## Çalıştırma

```bash
npm install
npm start
```

Kontrol:

```bash
npm run check
```

## Sağlık adresi

```text
/health
/healthz
```

## Önemli

Admin panelinin HTML/JavaScript dosyalarının kullanıcı tarafından görülebilmesi güvenlik açığı değildir. Güvenlik, sunucu tarafındaki parola, TOTP, kısa ömürlü oturum ve her komutta yapılan yetki kontrolüne dayanır. Parola veya TOTP secret hiçbir zaman web dosyalarına ya da mobil APK içine yazılmamalıdır.

---

# Token A.1 — Ücretsiz Supabase Kalıcılığı

Bu sürüm Render'ın geçici yerel dosya sistemine ek olarak sunucunun bütün durumunu Supabase'e imzalı ve sıkıştırılmış biçimde kaydeder.

Kalıcı kopyaya şunlar dahildir:

- RFX Token cüzdanları ve işlem defteri
- Premium ve promosyon kayıtları
- Arkadaşlıklar, mesajlar ve gruplar
- Duyurular ve Admin Studio ayarları
- Çark, bulut yedekleri, benchmark ve topluluk kayıtları
- Uygulama kontrol ayarları ve güvenlik kayıtları

## 1. Supabase SQL kurulumu

Supabase Dashboard içinden **SQL Editor** bölümünü aç ve paketteki şu dosyanın tamamını çalıştır:

```text
supabase_kalici_veri.sql
```

İşlem sonunda `relaxfps_server_state` tablosu ile `relaxfps_save_server_state(...)` fonksiyonu görünür.

Tabloda RLS zorunludur. `anon` ve `authenticated` rolleri hiçbir erişim almaz. Yalnızca sunucu tarafındaki `service_role` erişebilir.

## 2. Render ortam değişkenleri

Render > RELAXFPS servisi > Environment bölümüne ekle:

```text
SUPABASE_URL=https://PROJE_KODUN.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
RELAXFPS_SUPABASE_SYNC=true
```

Yeni `sb_secret_...` anahtarın yoksa geçici olarak legacy sunucu anahtarı kullanılabilir:

```text
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

`SUPABASE_SECRET_KEY` ile `SUPABASE_SERVICE_ROLE_KEY` değişkenlerinden yalnızca birini eklemek yeterlidir. Yeni secret key tercih edilir.

Bu anahtarı:

- Flutter uygulamasına koyma.
- GitHub'a yükleme.
- Ekran görüntüsünde paylaşma.
- Publishable/anon anahtarla karıştırma.

Publishable veya anon anahtar bu sunucu kalıcılığı için yeterli değildir.

Mevcut şu değişken aynı kalmalıdır:

```text
RELAXFPS_WALLET_LEDGER_SECRET=<daha önce oluşturduğun sabit gizli değer>
```

`DATA_FILE` eklemek zorunda değilsin. Yerel JSON yalnızca geçici güvenlik kopyası olarak tutulur; asıl kalıcı kopya Supabase'dir.

## 3. Dağıtım sonrası kontrol

Sunucu `Live` olduktan sonra:

```text
https://relaxfps-friends-server.onrender.com/health
```

Beklenen bölüm:

```json
"persistence": {
  "mode": "supabase",
  "configured": true,
  "connected": true,
  "loadedFromCloud": true,
  "revision": 1,
  "dirty": false,
  "conflict": false,
  "lastError": ""
}
```

İlk çalıştırmada Supabase satırı henüz yoksa sunucu mevcut yerel veriyi otomatik olarak `revision: 1` ile yükler. Sonraki açılışlarda önce Supabase kopyası doğrulanır ve geri yüklenir.

## Güvenlik davranışı

- Veriler gzip ile sıkıştırılır.
- Kalıcı kopya, `RELAXFPS_WALLET_LEDGER_SECRET` üzerinden türetilen HMAC anahtarıyla imzalanır.
- İmza eşleşmezse bulut kopyası kullanılmaz.
- Her kayıt bir `revision` numarası taşır.
- Eski bir Render örneği daha yeni veriyi ezmeye çalışırsa veritabanı işlemi reddeder.
- Revision çakışmasında token işlemleri güvenlik amacıyla durdurulur.
- Token harcama, cüzdan oluşturma ve cüzdan kurtarma cevapları ancak Supabase kaydı başarılı olduktan sonra kullanıcıya başarılı döner.

## Admin Studio

Genel bakış ekranında şu bilgiler görünür:

- Supabase bağlantısı
- Bulut revision numarası
- Son kayıt zamanı
- Bekleyen değişiklik
- Sürüm çakışması
- Son Supabase hatası

## İsteğe bağlı gelişmiş değişkenler

Normal kullanımda bunları ekleme:

```text
RELAXFPS_SUPABASE_STATE_ID=primary
RELAXFPS_SUPABASE_TIMEOUT_MS=15000
RELAXFPS_SUPABASE_SAVE_DEBOUNCE_MS=1200
RELAXFPS_SUPABASE_MAX_COMPRESSED_BYTES=12582912
```

`RELAXFPS_SUPABASE_STATE_ID` değerini daha sonra değiştirmek yeni ve boş bir sunucu durumu oluşturur. Bu nedenle varsayılan `primary` değerini koru.

## Acil durumda Supabase'i kapatma

Yalnızca test veya sorun tespiti için:

```text
RELAXFPS_SUPABASE_SYNC=false
```

Bu durumda sunucu yerel geçici moda geçer. Gerçek token sistemi için bu mod kullanılmamalıdır.
