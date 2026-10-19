"""Browser sweep: open every view at phone and desktop size, record console errors and horizontal overflow, save
screenshots. Usage: python tests/browser/routes.py [base_url] [out_dir] [--walk] [--theme light]
--walk also runs a full Gemba walk (real model calls) and approves the first card.
"""
import asyncio
import pathlib
import sys

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "http://127.0.0.1:8411"
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "qa-shots")
THEME = "light" if "light" in sys.argv else "dark"
ROUTES = ["#/", "#/machine/VMC-204", "#/machine/CMP-901", "#/machine/GRD-102", "#/cad/VMC-204", "#/cad/CMP-901", "#/quality", "#/energy", "#/supply", "#/ask", "#/learn", "#/work", "#/trust", "#/walk"]
SIZES = [(1440, 900), (390, 844)]


async def sweep(p, w, hgt, problems):
    b = await p.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
    ctx = await b.new_context(viewport={"width": w, "height": hgt}, device_scale_factor=1 if w > 800 else 2)
    await ctx.add_init_script(f"try{{localStorage.setItem('gemba-theme','{THEME}');localStorage.setItem('gemba-welcomed','1')}}catch(e){{}}")
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(f"pageerror {e}"))
    pg.on("console", lambda m: errs.append(f"console {m.text}") if m.type == "error" else None)
    for r in ROUTES:
        errs.clear()
        await pg.goto(f"{BASE}/{r}")
        await pg.wait_for_timeout(3500)
        over = await pg.evaluate("Math.max(document.documentElement.scrollWidth, document.querySelector('main').scrollWidth) - innerWidth")
        name = r.strip("#/").replace("/", "_") or "floor"
        await pg.screenshot(path=str(OUT / f"{name}_{w}.png"))
        if over > 1:
            problems.append(f"{r} @{w}: horizontal overflow {over}px")
        for e in errs:
            if "GL Driver" not in e:
                problems.append(f"{r} @{w}: {e[:200]}")
    if "--walk" in sys.argv and w > 800:
        await pg.goto(f"{BASE}/#/walk?start=1")
        await pg.wait_for_selector(".gcard", timeout=150000)
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=str(OUT / f"walk_done_{w}.png"), full_page=False)
        await pg.evaluate("document.querySelector('main').scrollTo(0, document.querySelector('.cards').offsetTop - 80)")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=str(OUT / f"walk_cards_{w}.png"))
        btn = pg.locator(".gcard .btn.ok").first
        await btn.click()
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=str(OUT / f"walk_no_name_{w}.png"))
        await pg.locator(".gcard input[type=text]").first.fill("Asha Patil")
        await pg.locator(".gcard .btn.ok").first.click()
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=str(OUT / f"walk_approved_{w}.png"))
    await b.close()


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    problems = []
    async with async_playwright() as p:
        for w, hgt in SIZES:
            await sweep(p, w, hgt, problems)
    print("\n".join(problems) or "no console errors, no horizontal overflow")
    print("screenshots:", OUT)


asyncio.run(main())
