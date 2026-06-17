RelaxFPS Friends Server v4
Bu sürüm Firebase veya harici sohbet servisi kullanmadan RELAXFPS için kendi arkadaş sunucusu mantığını çalıştırır.
Ana özellikler
RelaxFPS ID ile kayıt
Online/offline presence
Arkadaş listesi
Yazı mesajı
Görsel mesajı
Offline mesaj kuyruğu
Sohbet geçmişi
Okundu/teslim bilgisi
Sesli arama sinyal aktarımı
Kendi Relay Voice odaları
Kendi Relay Voice mantığı
WebRTC farklı internetlerde ses geçiremezse RELAXFPS kendi relay sistemini kullanabilir:
```text
Telefon A mikrofonu
↓
Konuşma şiddeti algılanır
↓
Sadece konuşulan kısımlar düşük kalite 8 kHz PCM paketlere küçültülür
↓
WebSocket ile RELAXFPS sunucusundaki özel odaya gelir
↓
Sunucu paketi online Arkadaş B’ye anlık yollar
↓
Arkadaş B paketi görünmez şekilde çalar
```
Bu sistem profesyonel WebRTC/TURN kalitesinde değildir, ama cihazdan cihaza doğrudan ses yolu bulamadığında kendi sunucumuz üzerinden çalışmak için tasarlanmıştır.
Çalıştırma
```bash
npm install
npm start
```
Yerel test:
```text
ws://BILGISAYAR_IP_ADRESIN:8080
```
Render kullanımı:
```text
wss://relaxfps-friends-server.onrender.com
```
Not: Render Free plan uykuya geçebilir. Kendi VPS kullanılırsa sunucu sürekli açık kalır ve Relay Voice daha stabil olur.
