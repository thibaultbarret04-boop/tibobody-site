// Bloque l'accès direct aux PDF des e-books (/ebooks-files/...).
// Les acheteurs les téléchargent uniquement via les liens signés de /api/fichier/…
export function onRequest() {
  return new Response('Introuvable', { status: 404, headers: { 'X-Robots-Tag': 'noindex' } });
}