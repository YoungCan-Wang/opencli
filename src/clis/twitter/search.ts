import { cli, Strategy } from '../../registry.js';

cli({
  site: 'twitter',
  name: 'search',
  description: 'Search Twitter/X for tweets',
  domain: 'x.com',
  strategy: Strategy.INTERCEPT, // Use intercept strategy
  browser: true,
  args: [
    { name: 'query', type: 'string', required: true },
    { name: 'limit', type: 'int', default: 15 },
  ],
  columns: ['id', 'author', 'text', 'likes', 'views', 'url'],
  func: async (page, kwargs) => {
    // 1. Navigate to the search page
    const q = encodeURIComponent(kwargs.query);
    await page.goto(`https://x.com/search?q=${q}&f=top`);
    await page.wait(5);

    // 2. Inject XHR interceptor
    await page.installInterceptor('SearchTimeline');

    // 3. Trigger API by scrolling
    await page.autoScroll({ times: 3, delayMs: 2000 });
    
    // 4. Retrieve data
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

          // Handle retweet wrapping
          if (tweet.__typename === 'TweetWithVisibilityResults' && tweet.tweet) {
              tweet = tweet.tweet;
          }

          results.push({
            id: tweet.rest_id,
            author: tweet.core?.user_results?.result?.legacy?.screen_name || 'unknown',
            text: tweet.legacy?.full_text || '',
            likes: tweet.legacy?.favorite_count || 0,
            views: tweet.views?.count || '0',
            url: `https://x.com/i/status/${tweet.rest_id}`
          });
        }
      } catch (e) {
        // ignore parsing errors for individual payloads
      }
    }

    return results.slice(0, kwargs.limit);
  }
});
