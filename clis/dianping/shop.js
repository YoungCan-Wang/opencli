/**
 * dianping shop — read shop detail by shop ID (the alphanumeric handle in
 * `https://www.dianping.com/shop/<shop_id>`).
 *
 * Returns a key/value sheet so the table view stays readable when fields
 * are absent (phone is hidden on PC web — only shows in app — so the row
 * surfaces it as `null` rather than fabricating).
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    SHOP_COLUMNS,
    detectAuthOrPageFailure,
    normalizeShopId,
    parsePrice,
    parseReviewCount,
    wrapDianpingStep,
} from './utils.js';

cli({
    site: 'dianping',
    name: 'shop',
    access: 'read',
    aliases: ['detail'],
    description: '大众点评店铺详情（按 shop_id）',
    domain: 'www.dianping.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'shop_id', required: true, positional: true, help: '店铺 ID（来自 search 的 shop_id 列，或 https://www.dianping.com/shop/<id> URL 段）' },
    ],
    columns: SHOP_COLUMNS,
    func: async (page, kwargs) => {
        const shopId = normalizeShopId(kwargs.shop_id);

        const url = `https://www.dianping.com/shop/${shopId}`;
        await wrapDianpingStep(`shop ${shopId} navigation`, async () => {
            await page.goto(url);
            await page.wait(3);
        });

        const data = await wrapDianpingStep(`shop ${shopId} extraction`, () => page.evaluate(`
            (() => {
                const head = document.querySelector('.shop-head');
                if (!head) {
                    return {
                        ok: false,
                        bodyLen: document.body.innerText.length,
                        sample: document.body.innerText.slice(0, 800),
                        url: location.href,
                    };
                }
                const headText = head.textContent.trim().replace(/\\s+/g, ' ');
                const titleEl = document.querySelector('.shop-name, .shop-head h2, .shop-head h1');
                const name = titleEl?.textContent?.trim() || (document.title || '').split(/[\\[\\]]/)[1] || '';
                const ratingText = document.querySelector('.star-score')?.textContent?.trim() || '';
                const features = Array.from(document.querySelectorAll('.shop-feature')).map((f) => f.textContent.trim()).filter(Boolean);
                const address = document.querySelector('.desc-info')?.textContent?.trim() || '';
                const subwayMatch = headText.match(/距(?:地铁)?[^\\s]+?步行\\d+m/);
                const subway = subwayMatch ? subwayMatch[0] : '';

                // Shop-head text holds price + cuisine + district + rank.
                const priceMatch = headText.match(/[¥￥]\\s*\\d+(?:\\.\\d+)?/);
                const reviewsMatch = headText.match(/(\\d+(?:[\\.,]\\d+)?(?:万)?)\\s*条/);

                // Try to read score breakdown ("口味:4.8 环境:4.8 服务:4.8 食材:4.9").
                const breakdown = {};
                const breakKeys = ['口味', '环境', '服务', '食材'];
                for (const key of breakKeys) {
                    const m = headText.match(new RegExp(key + '[:：]\\\\s*([0-9.]+)'));
                    if (m) breakdown[key] = Number(m[1]);
                }

                // Hours: "营业中 11:00-次日02:00" / "今日休息".
                const hoursMatch = headText.match(/营业中[^\\s]*\\d{1,2}:\\d{2}-(?:次日)?\\d{1,2}:\\d{2}|今日休息|暂停营业/);

                // Rank line: "海淀区 重庆火锅 口味榜 · 第1名".
                const rankMatch = headText.match(/[^\\s]+?(?:口味|人气|环境|服务)榜\\s*[·•]\\s*第\\d+名/);

                return {
                    ok: true,
                    name,
                    rating: ratingText,
                    reviewsRaw: reviewsMatch?.[1] || '',
                    priceRaw: priceMatch?.[0] || '',
                    breakdown,
                    features,
                    address,
                    subway,
                    hours: hoursMatch?.[0] || '',
                    rank: rankMatch?.[0] || '',
                    url: location.href,
                };
            })()
        `));

        if (!data || !data.ok) {
            detectAuthOrPageFailure(
                { text: String(data?.sample || ''), url: String(data?.url || url) },
                `shop ${shopId}`,
                { emptyPatterns: [/商户不存在|店铺不存在|店铺已关闭|页面不存在|404|已下线|没有找到相关商户/i] },
            );
        }

        const rating = data.rating ? Number(data.rating) : null;
        const reviews = parseReviewCount(data.reviewsRaw);
        const price = parsePrice(data.priceRaw);
        const breakdown = data.breakdown || {};

        const fields = [
            ['shop_id', shopId],
            ['name', data.name || ''],
            ['rating', Number.isFinite(rating) ? rating : null],
            ['reviews', reviews],
            ['price', price],
            ['rank', data.rank || ''],
            ['taste', Number.isFinite(breakdown['口味']) ? breakdown['口味'] : null],
            ['environment', Number.isFinite(breakdown['环境']) ? breakdown['环境'] : null],
            ['service', Number.isFinite(breakdown['服务']) ? breakdown['服务'] : null],
            ['ingredients', Number.isFinite(breakdown['食材']) ? breakdown['食材'] : null],
            ['hours', data.hours || ''],
            ['address', data.address || ''],
            ['subway', data.subway || ''],
            ['features', (data.features || []).join(', ')],
            ['url', data.url || url],
        ];

        return fields.map(([field, value]) => ({ field, value }));
    },
});
