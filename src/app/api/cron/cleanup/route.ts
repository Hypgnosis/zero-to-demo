import { NextResponse } from 'next/server';
import { getExpiredSessionIds, deleteSession } from '@/lib/redis';
import { Index } from '@upstash/vector';

export const dynamic = 'force-dynamic';
// Add authentication if required by Vercel Cron, usually protected by VERCEL_CRON_SECRET header but omitting for simplicity as per requirement.

export async function GET(req: Request) {
  // Validate caller if using Vercel Cron
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Get all expired session IDs from Redis
    const expiredSessionIds = await getExpiredSessionIds();
    
    if (expiredSessionIds.length === 0) {
      return NextResponse.json({ status: 'ok', message: 'No expired sessions found', deletedCount: 0 });
    }

    // 2. Initialize Vector client
    const UPSTASH_VECTOR_REST_URL = process.env.UPSTASH_VECTOR_REST_URL;
    const UPSTASH_VECTOR_REST_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;

    if (!UPSTASH_VECTOR_REST_URL || !UPSTASH_VECTOR_REST_TOKEN) {
      throw new Error('Vector DB credentials missing.');
    }

    const vectorIndex = new Index({
      url: UPSTASH_VECTOR_REST_URL,
      token: UPSTASH_VECTOR_REST_TOKEN,
    });

    console.log(`[Cron Cleanup] Found ${expiredSessionIds.length} expired sessions. Processing...`);

    let deletedCount = 0;

    for (const sessionId of expiredSessionIds) {
      try {
        // 3. Delete Upstash Vector namespace FIRST (ephemerality requirement)
        await vectorIndex.deleteNamespace(sessionId);
        
        // 4. Delete Redis key ONLY AFTER vector namespace is successfully deleted
        await deleteSession(sessionId);
        deletedCount++;
        
        console.log(`[Cron Cleanup] Purged session: ${sessionId}`);
      } catch (err) {
        console.error(`[Cron Cleanup] Failed to purge session ${sessionId}:`, err);
      }
    }

    return NextResponse.json({ 
      status: 'ok', 
      message: `Cleanup complete. Purged ${deletedCount}/${expiredSessionIds.length} sessions.`,
      deletedCount
    });
  } catch (error) {
    console.error('[Cron Cleanup] Critical failure:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
