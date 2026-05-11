// netlify/edge-functions/clinic-canonical.js
//
// Intercepts all /clinic/[slug] requests and replaces the hardcoded
// canonical href with the correct slug-specific URL before the response
// is sent. Googlebot sees the right canonical on first byte — no JS required.

export default async (request, context) => {
  const url = new URL(request.url);

  // Extract slug from path: /clinic/some-slug → "some-slug"
  const parts = url.pathname.split('/').filter(Boolean);
  const slug = parts[1]; // parts[0] === 'clinic'

  if (!slug) return context.next();

  // Fetch the original clinic.html response
  const response = await context.next();

  // Only process HTML responses
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const canonicalUrl = `https://skinday.ca/clinic/${slug}`;

  // Stream the HTML body and do a single string replacement.
  // The static fallback in clinic.html is:
  //   <link rel="canonical" id="meta-canonical" href="https://skinday.ca/" />
  // We replace only the href value, leaving the id intact so JS can still
  // update OG/Twitter tags via getElementById without breaking anything.
  const body = await response.text();

  const patched = body.replace(
    /<link\s+rel="canonical"\s+id="meta-canonical"\s+href="[^"]*"\s*\/>/,
    `<link rel="canonical" id="meta-canonical" href="${canonicalUrl}" />`
  );

  return new Response(patched, {
    status: response.status,
    headers: response.headers,
  });
};

export const config = {
  path: '/clinic/*',
};
