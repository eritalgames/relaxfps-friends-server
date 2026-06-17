RelaxFPS Friends Server v3.1
Firebase yok. Bu küçük Node.js WebSocket sunucusu RelaxFPS Friends için çalışır.
Özellikler
RelaxFPS ID ile kayıt
Aynı kullanıcı için birden fazla WebSocket bağlantısı desteği
Online/offline presence
Hızlı arkadaş ekleme ve arkadaş listesini sunucudan eşitleme
Arkadaş isteği / kabul / reddetme altyapısı
ID'den ID'ye mesaj iletimi
Offline mesaj kuyruğu
Sohbet geçmişi
Okundu bildirimi
Sesli/görüntülü arama için sinyal altyapısı
Basit JSON dosyasına kayıt
HTTP sağlık kontrolü: `/health`
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
Tarayıcıdan kontrol:
```text
https://relaxfps-friends-server.onrender.com/health
```
Not: Render Free plan uykuya geçebilir. Ücretli plana geçmeden de çalışır; sadece ilk bağlantı bazen yavaş uyanır.
Bu zipteki uygulama tarafı ekleri
Bu pakette sunucu dosyalarına ek olarak RELAXFPS GAME uygulaması için Tools güncellemesi de vardır:
Tools > Virtual RAM / Sanal RAM
Tools > Gaming Extreme Mode / Gaming Extreme Modu
Sanal RAM özelliği normal Android izinleriyle güvenli storage-backed profil oluşturur. Gerçek swap/zRAM için cihazın ayrıcalıklı sistem desteği gerekir.
