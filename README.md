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
