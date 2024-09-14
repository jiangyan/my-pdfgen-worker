import puppeteer from "@cloudflare/puppeteer";
import { type Env, Hono } from "hono";

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;
const TEN_SECONDS = 10000;



export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const id = env.MY_DURABLE_OBJECT.newUniqueId();
    const stub = env.MY_DURABLE_OBJECT.get(id);
    return stub.fetch(request);
  }
}

export class Browser {
  state: DurableObjectState;
  env: Env;
  keptAliveInSeconds: number;
  storage: DurableObjectStorage;
  browser: puppeteer.Browser | undefined;
  app: Hono = new Hono();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.keptAliveInSeconds = 0;
    this.storage = this.state.storage;  // This assigns the storage from the state
    this.env = env;

    // Add the route for PDF generation
    this.app.get("/", async (c) => {
      const url = c.req.query("url");  // Capture URL from query params
      if (!url) {
        return c.text("Missing URL query parameter.", 400);  // Handle missing URL
      }

      const isBrowserActive = await this.ensureBrowser();
      if (!isBrowserActive) {
        return c.text("Could not start browser instance.", 500);
      }

      const page = await this.browser?.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });  // Navigate to the URL

      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
      });

      await page.close();

      // Return the PDF as the response
      return c.body(pdf, 200, { "Content-Type": "application/pdf" });
    });
  }

  
  async ensureBrowser() {
    let retries = 3;

    while (retries) {
      if (!this.browser || !this.browser.isConnected()) {
        try {
          this.browser = await puppeteer.launch(this.env.MYBROWSER);  // Use env.MYBROWSER
          return true;
        } catch (e) {
          console.error(`Could not start browser instance. Error: ${e}`);
          retries--;
          if (!retries) {
            return false;
          }
        }

        const sessions = await puppeteer.sessions(this.env.MYBROWSER);
        for (const session of sessions) {
          const b = await puppeteer.connect(
            this.env.MYBROWSER,
            session.sessionId,
          );
          await b.close();
        }
        console.log(
          `.Retrying to start browser instance. Retries left: ${retries}`,
        );
      } else {
        return true;
      }
    }
  }

  async generatePdf({ body, filename }: { body: string; filename: string }) {
    try {
      const isBrowserActive = await this.ensureBrowser();
      if (!isBrowserActive) {
        return;
      }

      const page = await this.browser?.newPage();
      await page.emulateMediaType("screen");
      await page.setContent(body);

      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
      });
      return pdf;
    } catch (e) {
      console.error(`Could not generate PDF. Error: ${e}`);
      return;
    }
  }

  async alarm() {
    this.keptAliveInSeconds += 10;
    if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
      await this.storage.setAlarm(Date.now() + TEN_SECONDS);
    } else {
      if (this.browser) {
        await this.browser.close();
        this.browser = undefined;
      }
    }
  }

  // Fetch method for handling incoming requests
  async fetch(request: Request) {
    return this.app.fetch(request);  // Use Hono's internal fetch handling
  }
}
