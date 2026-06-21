Admin Studio v2 Genişletme
Bu sürümde gizli geliştirici paneli uygulamayı uzaktan yönetmek için genişletildi.
Yeni yönetim alanları:
Uzaktan özellik aç/kapat: Friends, Groups (`communityEnabled` uyumluluk anahtarı), RelaxBench, WinSimPro, Gaming Extreme, App Lock, Sound Booster, Virtual RAM, Overlay, mesajlaşma, görsel, sesli arama ve Relay Voice.
Bakım modu: bakım mesajı ve tahmini bitiş notu.
Zorunlu güncelleme: minimum sürüm, son sürüm, Play Store linki ve güncelleme mesajı.
Kullanıcı yönetimi: premium süresi, ban, test kullanıcısı, kullanıcı notu, tek/toplu geliştirici mesajı.
İçerik yönetimi: duyuru, görsel, video, kaynak linki, özel panel, buton aksiyonu.
Hata raporları ve kullanım olayları: `crash\_report` ve `client\_event` mesaj tipleri.
Yedekleme: admin panelinden JSON state yedeği oluşturma.
Admin güvenliği: oturum süresi, hatalı giriş sayacı ve audit log.
Yeni public komutlar:
```json
{ "type": "get\_app\_config" }
{ "type": "client\_event", "from": "RFX-...", "event": "tool\_opened", "meta": {"tool":"RelaxBench"} }
{ "type": "crash\_report", "from": "RFX-...", "screen": "Tools", "error": "...", "stack": "..." }
```
Yeni admin komutları:
```json
admin\_update\_app\_settings
admin\_set\_test\_user
admin\_set\_user\_note
admin\_backup\_now
admin\_clear\_admin\_log
admin\_clear\_crash\_reports
admin\_update\_security
```
Büyük Yenileme Paketi
Bu sürümde Admin Studio ayarları uygulama tarafından `get\_app\_config` ile okunur. Bakım modu ve temel özellik aç/kapat değerleri istemciye uygulanır. Admin panelinden verilen Premium erişim, kullanıcının sunucuya kayıt olduğu anda `premiumGrant` alanıyla veya çevrim içiyken `premium\_granted` olayıyla gönderilir. Kaldırma işlemi `premium\_removed` olayıyla bildirilir.
RelaxBench genel cihaz sıralaması
```json
{ "type": "bench\_leaderboard", "requestId": "...", "id": "RFX-1234-5678", "limit": 100 }
```
```json
{
  "type": "bench\_submit",
  "requestId": "...",
  "id": "RFX-1234-5678",
  "manufacturer": "Xiaomi",
  "model": "Device model",
  "androidVersion": "15",
  "totalScore": 123456,
  "categoryScores": { "cpu": 20000, "gpu": 25000 }
}
```
Sunucu her RelaxFPS kimliği için son testi kalıcı state dosyasına kaydeder; genel sıra, kişisel sıra, önceki skor ve aynı model ortalaması döndürülür.
v4.2 Günlük Ödül ve Promosyon Kodları
Bu sürümde mağazadaki kod alanı ve günlük ödül sistemi için sunucu desteği eklendi.
Public komut:
```json
{ "type": "redeem\_promo\_code", "requestId": "...", "id": "RFX-1234-5678", "code": "RELAX-1AY" }
```
Admin komutları:
```json
{ "type": "admin\_upsert\_promo\_code", "code": "RELAX-1AY", "rewardType": "premium", "durationMinutes": 43200, "maxUses": 100, "active": true }
{ "type": "admin\_delete\_promo\_code", "code": "RELAX-1AY" }
```
Desteklenen ödül türleri: `premium`, `ad\_free`, `winsim`, `friends\_minutes`. Kodlar kullanıcı başına bir kez kullanılabilir; son kullanım tarihi ve toplam kullanım limiti belirlenebilir.
Duyuru editörüne sabitleme, 0–100 öncelik ve isteğe bağlı bitiş tarihi alanları eklendi. Sabit ve yüksek öncelikli duyurular kullanıcı akışında önce gösterilir.

v5.0 Arkadaşlar, Gruplar ve Relay Voice
Bu sürüm Arkadaşlar bölümünü tek merkezli çevrim içi sistem haline getirir.
Başlıca yenilikler:
Birebir mesajlarda gönderildi, iletildi ve okundu zamanları.
Mesajı herkesten silme ve karşı tarafta “Bu mesaj silindi” durumu.
Android mesaj ve çağrı bildirimleri için genişletilmiş olay verileri.
Birebir ve grup Relay Voice paket yönlendirmesi.
Grup oluşturma, davet, kabul/red, yönetici, üye çıkarma, ayrılma ve grup silme.
Grup mesaj geçmişi, görsel mesajlar ve grup araması.
Ücretsiz Arkadaşlar süresi 15 dakika.
Çevrim içi kullanım süresi RelaxFPS kimliğine göre sunucuda kalıcı tutulur; yeniden kurulumda süre yeniden başlamaz.
Aynı kullanıcı birden fazla sohbet/arama bağlantısı açsa bile kullanım süresi yalnız bir kez işler.
Yeni veya genişletilen istemci komutları:
```json
{ "type": "friend\_usage\_status", "id": "RFX-1234-5678", "timezoneOffsetMinutes": 180 }
{ "type": "message\_delete", "from": "RFX-...", "to": "RFX-...", "messageId": "...", "deleteForAll": true }
{ "type": "groups\_list", "id": "RFX-..." }
{ "type": "group\_create", "from": "RFX-...", "name": "Takım" }
{ "type": "group\_invite", "groupId": "group-...", "from": "RFX-...", "to": "RFX-..." }
{ "type": "group\_message", "groupId": "group-...", "from": "RFX-...", "kind": "text", "text": "Merhaba" }
{ "type": "group\_call\_invite", "groupId": "group-...", "from": "RFX-..." }
{ "type": "group\_relay\_audio", "groupId": "group-...", "from": "RFX-...", "data": "...", "sampleRate": 8000 }
```
Kayıt yanıtındaki `friendUsage` alanı günlük kullanılan, kalan ve toplam saniyeyi döndürür. Sunucu çevrim içi kullanıcılara yaklaşık 10 saniyede bir `friend\_usage` olayı gönderir.

v5.1 Sunucuya Bağlı Günlük Ödül Çarkı
Çark durumu artık cihazdaki yerel kayda güvenmez. Son çevirme zamanı, 24 saatlik kilit, ödül geçmişi, kişisel kodlar ve geçici erişimler RelaxFPS kimliğine göre sunucu state dosyasında tutulur. Uygulama kaldırılıp yeniden kurulduğunda aynı kalıcı ID ile veriler geri gelir.
Yeni public komutlar:
```json
{ "type": "get\_daily\_wheel\_state", "requestId": "...", "id": "RFX-1234-5678" }
{ "type": "spin\_daily\_wheel", "requestId": "...", "id": "RFX-1234-5678" }
{ "type": "get\_premium\_offer\_state", "requestId": "...", "id": "RFX-1234-5678" }
```
Ödül dağılımı:
`%20` +20 dakika çevrim içi süre
`%4` 1 saat Premium kişisel kodu
`%10` 1 gün WinSimPro
`%2` Premium ilk ay `%20` indirim kodu
`%40` tekrar dene; hak tüketilmez ancak yeniden reklam gerekir
`%2` 1 gün Shizuku Tools
`%2` Premium ilk ay `%40` indirim kodu
`%20` 6 saat reklamsız kullanım
Kişisel çark kodlarında `ownerId` bulunur ve kod başka RelaxFPS kimliğinde kullanılamaz. Premium indirim kodlarının gerçek Google Play fiyatına uygulanabilmesi için Play Console abonelik tekliflerinde sırasıyla `relaxfps\_wheel\_20` ve `relaxfps\_wheel\_40` teklif etiketleri tanımlanmalıdır.
