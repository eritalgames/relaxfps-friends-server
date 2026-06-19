Admin Studio v2 Genişletme
Bu sürümde gizli geliştirici paneli uygulamayı uzaktan yönetmek için genişletildi.
Yeni yönetim alanları:
Uzaktan özellik aç/kapat: Friends, Community, RelaxBench, WinSimPro, Gaming Extreme, App Lock, Sound Booster, Virtual RAM, Overlay, mesajlaşma, görsel, sesli arama ve Relay Voice.
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
