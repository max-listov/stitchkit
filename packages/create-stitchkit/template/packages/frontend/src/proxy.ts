import { type NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { catalogueIsOpen } from './env';
import { routing } from './i18n/routing';

const localized = createMiddleware(routing);
const CATALOGUE = new RegExp(`^/(?:${routing.locales.join('|')})/ui(?:/|$)`);

/** Decided at the door, per request, so one check covers every page of the catalogue. */
export default function proxy(request: NextRequest): NextResponse {
  if (CATALOGUE.test(request.nextUrl.pathname) && !catalogueIsOpen()) {
    return new NextResponse(null, { status: 404 });
  }
  return localized(request);
}

export const config = { matcher: ['/', '/(en|ru)/:path*'] };
