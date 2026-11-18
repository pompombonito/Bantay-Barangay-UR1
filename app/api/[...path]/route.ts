import { env } from 'cloudflare:workers';
import { handleRemoteApi } from '@/lib/remote-api.mjs';

export const dynamic = 'force-dynamic';
export function GET(request: Request) { return handleRemoteApi(request, env); }
export function POST(request: Request) { return handleRemoteApi(request, env); }
