/**
 * Vercel Serverless Function: /api/proxy?url=...
 * Пересилає запит до freeserp.ai на стороні сервера, тому CORS у браузері не заважає.
 * Нічого налаштовувати не треба: Vercel сам підхоплює файли з папки /api.
 */
const ALLOWED_HOST = 'freeserp.ai'; // Не відкритий relay: тільки цей хост

export default async function handler(req, res) {
  let target;
  try {
    target = new URL(req.query.url);
  } catch {
    return res.status(400).send('Bad url');
  }
  if (target.hostname !== ALLOWED_HOST) {
    return res.status(403).send('Host not allowed');
  }

  try {
    const upstream = await fetch(target, { headers: { Accept: 'application/json' } });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // Кеш на 5 хвилин
    return res.status(upstream.status).send(body);
  } catch (err) {
    return res.status(502).send(`Proxy error: ${err.message}`);
  }
}
