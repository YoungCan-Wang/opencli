import { cli, Strategy } from '../../registry.js';

cli({
  site: 'xiaohongshu',
  name: 'user',
  description: 'Get user notes from Xiaohongshu',
  domain: 'xiaohongshu.com',
  strategy: Strategy.INTERCEPT,
  browser: true,
  args: [
    { name: 'id', type: 'string', required: true },
    { name: 'limit', type: 'int', default: 15 },
  ],
  columns: ['id', 'title', 'type', 'likes', 'url'],
  func: async (page, kwargs) => {
    await page.goto(`https://www.xiaohongshu.com/user/profile/${kwargs.id}`);
    await page.wait(5);

    await page.installInterceptor('v1/user/posted');

    // Trigger API by scrolling
    await page.autoScroll({ times: 2, delayMs: 2000 });
    
    // Retrieve data
    const requests = await page.getInterceptedRequests();
    if (!requests || requests.length === 0) return [];

    let results: any[] = [];
    for (const req of requests) {
      if (req.data && req.data.data && req.data.data.notes) {
         for (const note of req.data.data.notes) {
           results.push({
             id: note.note_id || note.id,
             title: note.display_title || '',
             type: note.type || '',
             likes: note.interact_info?.liked_count || '0',
             url: `https://www.xiaohongshu.com/explore/${note.note_id || note.id}`
           });
         }
      }
    }

    return results.slice(0, kwargs.limit);
  }
});
