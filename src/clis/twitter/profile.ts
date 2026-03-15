import { cli, Strategy } from '../../registry.js';

cli({
  site: 'twitter',
  name: 'profile',
  description: 'Fetch tweets from a user profile',
  domain: 'x.com',
  strategy: Strategy.INTERCEPT,
  browser: true,
  args: [
    { name: 'username', type: 'string', required: true },
    { name: 'limit', type: 'int', default: 15 },
  ],
  columns: ['id', 'text', 'likes', 'views', 'url'],
  func: async (page, kwargs) => {
    // Navigate to user profile via search for reliability
    await page.goto(`https://x.com/search?q=from:${kwargs.username}&f=live`);
    await page.wait(5);

    // Inject XHR interceptor
    await page.installInterceptor('SearchTimeline');

    // Trigger API by scrolling
    await page.autoScroll({ times: 3, delayMs: 2000 });
    
    // Retrieve data
    const requests = await page.getInterceptedRequests();
    if (!requests || requests.length === 0) return [];

    let results: any[] = [];
    for (const req of requests) {
      try {
        const insts = req.data.data.search_by_raw_query.search_timeline.timeline.instructions;
        const addEntries = insts.find((i: any) => i.type === 'TimelineAddEntries');
        if (!addEntries) continue;

        for (const entry of addEntries.entries) {
          if (!entry.entryId.startsWith('tweet-')) continue;
          
          let tweet = entry.content?.itemContent?.tweet_results?.result;
          if (!tweet) continue;

          if (tweet.__typename === 'TweetWithVisibilityResults' && tweet.tweet) {
              tweet = tweet.tweet;
          }

          results.push({
            id: tweet.rest_id,
            text: tweet.legacy?.full_text || '',
            likes: tweet.legacy?.favorite_count || 0,
            views: tweet.views?.count || '0',
            url: `https://x.com/i/status/${tweet.rest_id}`
          });
        }
      } catch (e) {
      }
    }

    return results.slice(0, kwargs.limit);
  }
});
