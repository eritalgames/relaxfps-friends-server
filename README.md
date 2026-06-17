# RelaxFPS Friends Server v2

Firebase yok. Bu küçük Node.js WebSocket sunucusu RelaxFPS Friends için çalışır.

## Çalıştırma

```bash
npm install
npm start
```

Uygulamada yerel test adresi:

```text
ws://BILGISAYAR_IP_ADRESIN:8080
```

Örnek:

```text
ws://192.168.1.35:8080
```

## v2 özellikleri

- RelaxFPS ID ile kayıt
- Online/offline presence
- Arkadaş online durum sorgusu
- ID'den ID'ye mesaj iletimi
- Mesaj gönderildi / iletildi / sırada durumları
- Sunucu açık kaldığı sürece offline mesaj kuyruğu
- Firebase kullanmaz

## İnternete açma

Gerçek kullanıma almak için bu sunucuyu Render, Railway, VPS veya kendi domaininde yayınla.
Uygulamada hedef adres `wss://...` olmalı.
