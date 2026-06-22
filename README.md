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

# RFX Token A — Güvenli Sunucu Cüzdanı (v6.1)

Bu sürüm RFX Token ekonomisinin sunucu tarafındaki güvenli temelini ekler. Mobil uygulama, bakiyenin sahibi değildir; yalnızca sunucudaki cüzdanı görüntüler ve imzalı işlem isteği gönderir.

## Yeni zorunlu ortam değişkeni

Render ortam değişkenlerine, dağıtımdan **önce** sabit ve en az 32 karakterlik bir değer ekle:

```text
RELAXFPS_WALLET_LEDGER_SECRET=<çok uzun rastgele ve sabit gizli değer>
```

Örnek üretim komutu:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Bu değeri daha sonra değiştirme. İşlem defteri HMAC zinciri bu anahtarla doğrulanır. Secret değişirse sunucu güvenlik amacıyla token ekleme/harcama işlemlerini durdurur. Secret hiçbir zaman Flutter koduna, APK'ya veya GitHub deposuna yazılmamalıdır.

Sunucu geriye dönük uyumluluk için `RELAXFPS_ADMIN_SESSION_SECRET` değerinden geçici bir anahtar türetebilir; fakat `/health` yanıtında `wallet.securityConfigured` false görünür. Canlı kullanımda ayrı `RELAXFPS_WALLET_LEDGER_SECRET` mutlaka ayarlanmalıdır.

## Sunucu tarafında tutulan veriler

```text
wallets                 Kullanıcıların sunucu esaslı cüzdanları
walletTransactions      HMAC zincirli, eklemeli işlem defteri
walletRequestIndex      Aynı operationId'nin iki kez harcanmasını engeller
walletSecurityEvents    Hatalı anahtar, hız sınırı ve tekrar saldırısı kayıtları
walletSettings          Hoş geldin ödülü ve sunucu fiyat kataloğu
walletLedgerHead        Son doğrulanmış işlem hash'i
walletLedgerSequence    Küresel işlem sıra numarası
```

Cüzdan anahtarı, kurtarma anahtarı ve cihaz kimliği düz metin olarak tutulmaz. Sunucu anahtarlı HMAC özeti saklanır.

## Varsayılan ekonomi

- İlk güvenli cüzdan oluşturma: `+500 RFX Token`
- Premium kullanıcı: token harcamaz, işlem geçmişine `PREMIUM_BYPASS` kaydı düşer
- Normal optimizasyon: `30`
- Gelişmiş optimizasyon: `50`
- Basit testler: `5–15`
- Ağ testi: `20`
- Ağır termal/gecikme araçları: `75`
- Sunucu 10 dakika: `50`
- Sunucu 30 dakika: `100`
- Sunucu 2 saat: `250`
- Sunucu 24 saat: `500`

Fiyatların tamamı Admin Studio içindeki **RFX Token** bölümünden değiştirilebilir. Mobil uygulamanın gönderdiği fiyat kabul edilmez; gerçek fiyat her zaman sunucunun kataloğundan okunur.

## WebSocket cüzdan mesajları

### `wallet_catalog`

Kimlik doğrulama gerektirmeden güncel fiyat kataloğunu döndürür.

### `wallet_enroll`

Önce aynı RelaxFPS ID ile `register` yapılmalıdır. Ayrıca aynı kurtarma anahtarıyla bulut yedeği etkin olmalıdır.

```json
{
  "type": "wallet_enroll",
  "walletKey": "istemcide-üretilen-en-az-32-karakter-anahtar",
  "recoveryKey": "KULLANICININ-KURTARMA-ANAHTARI",
  "deviceId": "uygulamanın-yerel-cihaz-kimliği",
  "requestId": "benzersiz-istek"
}
```

İlk başarılı kayıtta 500 token yalnızca bir kez verilir. Uygulamayı silip tekrar kurmak yeni ödül oluşturmaz.

### `wallet_status`

```json
{
  "type": "wallet_status",
  "walletKey": "...",
  "requestId": "..."
}
```

### `wallet_spend`

```json
{
  "type": "wallet_spend",
  "walletKey": "...",
  "operationId": "her-işlem-icin-benzersiz-en-az-12-karakter",
  "action": "network_stability",
  "metadata": { "tool": "network" },
  "requestId": "arayüz-istek-kodu"
}
```

- `operationId` aynı kullanıcı için tekrar gönderilirse token ikinci kez düşmez.
- Aynı `operationId` farklı `action` ile kullanılırsa güvenlik olayı oluşturulur.
- Kullanıcının gönderdiği miktar yok sayılır; fiyat sunucudan gelir.
- Yetersiz bakiye sunucu tarafından reddedilir.
- Premium kullanıcı için bakiye düşmez.

### `wallet_history`

Son 1–200 işlemi sayfalı şekilde döndürür.

### `wallet_recover`

Yeni cihazda kurtarma anahtarı doğrulanır ve eski cüzdan anahtarı geçersiz hâle getirilerek yeni anahtar bağlanır.

## Admin Studio

Sol menüye **RFX Token** sayfası eklenmiştir:

- Toplam cüzdan ve dolaşımdaki token
- İşlem defteri bütünlük durumu
- Kullanıcı bakiyesi ekleme/çıkarma
- Cüzdanı geçici veya süresiz kilitleme
- Hoş geldin ödülü ve işlem fiyatlarını değiştirme
- Son token işlemleri
- Şüpheli güvenlik olayları
- HMAC işlem defterini elle doğrulama

Admin işlemleri de işlem defterine yazılır ve audit log'a eklenir.

## Güvenlik davranışı

- 8 hatalı cüzdan anahtarı denemesi aynı IP/ID için 15 dakikalık geçici doğrulama engeli oluşturur.
- Harcama uç noktası dakikada sınırlıdır.
- Aynı işlem isteği idempotenttir.
- Cüzdan bakiyesi yalnızca sunucuda değişir.
- İşlem defteri sunucu yeniden başladığında baştan doğrulanır.
- Defter hash'i veya ledger secret uyuşmazsa token mutasyonları kapanır.
- Tek bir istemci sinyalinde otomatik kalıcı ban uygulanmaz; güvenlik olayı Admin Studio'ya düşer.
- Veri dosyası geçici dosyaya yazılıp atomik olarak değiştirilir; yarım JSON yazımı riski azaltılır.

## Yeni cihaz ve yedek

Token bakiyesi bulut yedeği JSON'una konmaz. Yeni cihazda:

1. Kullanıcı RelaxFPS ID ile bağlanır.
2. Kurtarma anahtarını girer.
3. Uygulama yeni yüksek entropili `walletKey` üretir.
4. `wallet_recover` eski anahtarı iptal eder.
5. Bakiye ve işlem geçmişi sunucudan gelir.

## Bu aşamada henüz eklenmeyenler

Aşağıdaki özellikler sonraki aşamalarda bağlanacaktır:

- Flutter üst bar token göstergesi ve Token Merkezi
- Araç/optimizasyon ücretlerinin uygulama akışına bağlanması
- AdMob Server-Side Verification ile reklam ödülü
- Google Play token paketleri ve backend purchase doğrulaması
- Play Integrity risk sinyalleri

Token A yalnızca güvenli cüzdan, fiyat kataloğu, işlem defteri, yönetici araçları ve yeni cihaz kurtarma omurgasını oluşturur.
