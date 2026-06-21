Admin Studio v2 Genişletme
Bu sürümde gizli geliştirici paneli uygulamayı uzaktan yönetmek için genişletildi.
Yeni yönetim alanları:
Uzaktan özellik aç/kapat: Friends, Groups (`communityEnabled` uyumluluk anahtarı), RelaxBench, WinSimPro, Gaming Extreme, App Lock, Sound Booster, Virtual RAM, Overlay, mesajlaşma, görsel, sesli arama ve Relay Voice.
Bakım modu: bakım mesajı ve tahmini bitiş notu.
Zorunlu güncelleme: minimum sürüm, son sürüm, Play Store linki ve güncelleme mesajı.
Kullanıcı yönetimi: premium süresi, ban, test kullanıcısı, kullanıcı notu, tek/toplu geliştirici mesajı.
İçerik yönetimi: duyuru, görsel, video, kaynak linki, özel panel, buton aksiyonu.
Hata raporları ve kullanım olayları: `crash_report` ve `client_event` mesaj tipleri.
Yedekleme: admin panelinden JSON state yedeği oluşturma.
Admin güvenliği: oturum süresi, hatalı giriş sayacı ve audit log.
Yeni public komutlar:
```json
{ "type": "get_app_config" }
{ "type": "client_event", "from": "RFX-...", "event": "tool_opened", "meta": {"tool":"RelaxBench"} }
{ "type": "crash_report", "from": "RFX-...", "screen": "Tools", "error": "...", "stack": "..." }
```
Yeni admin komutları:
```json
admin_update_app_settings
admin_set_test_user
admin_set_user_note
admin_backup_now
admin_clear_admin_log
admin_clear_crash_reports
admin_update_security
```
Büyük Yenileme Paketi
Bu sürümde Admin Studio ayarları uygulama tarafından `get_app_config` ile okunur. Bakım modu ve temel özellik aç/kapat değerleri istemciye uygulanır. Admin panelinden verilen Premium erişim, kullanıcının sunucuya kayıt olduğu anda `premiumGrant` alanıyla veya çevrim içiyken `premium_granted` olayıyla gönderilir. Kaldırma işlemi `premium_removed` olayıyla bildirilir.
RelaxBench genel cihaz sıralaması
```json
{ "type": "bench_leaderboard", "requestId": "...", "id": "RFX-1234-5678", "limit": 100 }
```
```json
{
  "type": "bench_submit",
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
{ "type": "redeem_promo_code", "requestId": "...", "id": "RFX-1234-5678", "code": "RELAX-1AY" }
```
Admin komutları:
```json
{ "type": "admin_upsert_promo_code", "code": "RELAX-1AY", "rewardType": "premium", "durationMinutes": 43200, "maxUses": 100, "active": true }
{ "type": "admin_delete_promo_code", "code": "RELAX-1AY" }
```
Desteklenen ödül türleri: `premium`, `ad_free`, `winsim`, `friends_minutes`. Kodlar kullanıcı başına bir kez kullanılabilir; son kullanım tarihi ve toplam kullanım limiti belirlenebilir.
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
{ "type": "friend_usage_status", "id": "RFX-1234-5678", "timezoneOffsetMinutes": 180 }
{ "type": "message_delete", "from": "RFX-...", "to": "RFX-...", "messageId": "...", "deleteForAll": true }
{ "type": "groups_list", "id": "RFX-..." }
{ "type": "group_create", "from": "RFX-...", "name": "Takım" }
{ "type": "group_invite", "groupId": "group-...", "from": "RFX-...", "to": "RFX-..." }
{ "type": "group_message", "groupId": "group-...", "from": "RFX-...", "kind": "text", "text": "Merhaba" }
{ "type": "group_call_invite", "groupId": "group-...", "from": "RFX-..." }
{ "type": "group_relay_audio", "groupId": "group-...", "from": "RFX-...", "data": "...", "sampleRate": 8000 }
```
Kayıt yanıtındaki `friendUsage` alanı günlük kullanılan, kalan ve toplam saniyeyi döndürür. Sunucu çevrim içi kullanıcılara yaklaşık 10 saniyede bir `friend_usage` olayı gönderir.
