RelaxFPS Friends Server - Admin Panel
Bu sürümde WebSocket üzerinden çalışan geliştirici paneli altyapısı eklendi.
Gizli panel girişi
Uygulama içinde KMÜ görseline basılı tutup ardından görünür tepki olmadan 9 kez dokununca geliştirici giriş ekranı açılır.
Admin şifresi
Varsayılan şifre uygulamada değil, sunucu tarafında kontrol edilir.
Render ortam değişkeni olarak ayarlaman önerilir:
```text
RELAXFPS_ADMIN_PASSWORD=6a32beb1-0e30-83eb-bf71-be356cbd095a
```
Ortam değişkeni girilmezse server.js içindeki varsayılan şifre kullanılır.
Panel özellikleri
Kullanıcı listesi
Online kullanıcı durumu
Duyuru oluşturma
Duyuru görseli ekleme
Kullanıcıya geliştirici mesajı gönderme
Ban / ban kaldırma
Geri bildirim kayıt altyapısı
Sunucu sağlık kontrolü
Not
Bu panel gerçek yönetim için sunucuya bağlı çalışır. Uygulama içindeki gizli hareket sadece giriş kapısıdır; asıl doğrulama sunucuda yapılır.
