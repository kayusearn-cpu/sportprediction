import json, sys, asyncio
from crawl4ai import AsyncWebCrawler

async def fetch(url, selector=None, proxy=None):
    async with AsyncWebCrawler(verbose=False) as crawler:
        kwargs = {}
        if proxy:
            kwargs["proxy"] = proxy  # e.g. "http://user:pass@host:port"
        result = await crawler.arun(
            url=url,
            js_code="window.scrollBy(0, 500)",  # trigger lazy images
            bypass_cache=True,
            **kwargs
        )
        if not result.success:
            raise Exception(f"Crawl failed: {result.error_message}")

        if selector:
            elements = result.html.css.select(selector)
            items = [el.get_text(strip=True) for el in elements]
            return {"elements": items, "full_html": result.html.html}
        return {"html": result.html.html}

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python scraper.py <url> [selector] [proxy]"}))
        return
    url = sys.argv[1]
    selector = sys.argv[2] if len(sys.argv) > 2 else None
    proxy = sys.argv[3] if len(sys.argv) > 3 else None
    try:
        data = await fetch(url, selector, proxy)
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    asyncio.run(main())
