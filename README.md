RelaxFPS Friends Server v3.2
Firebase yok. Bu Node.js WebSocket sunucusu RELAXFPS Friends ekranının sade sürümü için çalışır.
Bu sürümde amaç
Uygulamada kullanıcıya sunucu ayarı göstermeden sadece şu üç şeyi çalıştırmak:
RELAXFPS ID ile arkadaş ekleme
Arkadaşla yazılı mesajlaşma ve görsel paylaşma
Sesli arama için WebRTC sinyal iletimi
Özellikler
RelaxFPS ID ile kayıt
Online/offline presence
ID ile direkt arkadaş ekleme
ID'den ID'ye metin mesajı
Base64 görsel mesajı iletimi
Offline mesaj kuyruğu
Sohbet geçmişi
Okundu / iletildi bilgisi için temel altyapı
Sesli arama için WebRTC offer/answer/candidate sinyal aktarımı
Basit JSON dosyasına kayıt
Render için `/health` kontrol adresi
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
Not: Render Free plan uykuya geçebilir. Ücretli plana geçmeden çalışır; ilk bağlantı bazen birkaç saniye geç uyanır.
