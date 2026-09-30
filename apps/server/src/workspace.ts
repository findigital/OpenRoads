import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  ActivityEntry,
  Artifact,
  BrowserSession,
  CalendarEvent,
  Mail,
  ProposalInput,
  Workspace,
} from "../../../packages/domain/src/index.ts";
import { GoogleClient } from "../../../packages/integrations/src/google.ts";
import {
  createCarrierProfilePdf,
  createSamplePdf,
} from "../../../packages/integrations/src/pdf.ts";
import type { ActionService } from "./actions.ts";
import { agentConfigured } from "./agent.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";
import type { GoogleAuth } from "./google-auth.ts";
import { sampleProfile } from "./persona.ts";

export class WorkspaceService {
  private seeding = new Map<string, Promise<void>>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly files: Files,
    private readonly googleAuth: GoogleAuth,
  ) {}
  google(owner: string, connectionId?: string) {
    return new GoogleClient({
      getAccessToken: () => this.googleAuth.accessToken(owner, connectionId),
    });
  }
  async connection(owner: string) {
    if (this.config.mode === "sample") {
      const value = await this.db.get<{ enabled: boolean; connectionId?: string }>(
        owner,
        "settings",
        "google",
      );
      return value?.enabled === false
        ? null
        : { id: value?.connectionId ?? "sample-google", account: this.sampleAccount().email };
    }
    const tokens = await this.googleAuth.tokens(owner);
    return tokens ? { id: tokens.connectionId, account: tokens.account } : null;
  }
  async connected(owner: string) {
    return this.config.mode === "sample"
      ? (await this.db.get<{ enabled: boolean }>(owner, "settings", "google"))?.enabled !== false
      : Boolean(await this.googleAuth.tokens(owner));
  }
  async calendars(owner: string) {
    const connection = await this.connection(owner);
    if (!connection) return [];
    if (this.config.mode === "sample")
      return [
        {
          id: "primary",
          name: "Personal",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          accessRole: "owner",
        },
      ];
    return this.google(owner, connection.id).listCalendars();
  }
  async events(
    owner: string,
    options: { calendarId?: string; timeMin?: string; timeMax?: string } = {},
  ) {
    const connection = await this.connection(owner);
    if (!connection) return [];
    if (this.config.mode === "live") return this.google(owner, connection.id).listEvents(options);
    return (await this.db.list<CalendarEvent>(owner, "events"))
      .filter(
        (event) =>
          event.calendarId === (options.calendarId ?? "primary") &&
          (!options.timeMax || Date.parse(event.start) < Date.parse(options.timeMax)) &&
          (!options.timeMin || Date.parse(event.end) > Date.parse(options.timeMin)),
      )
      .sort((a, b) => a.start.localeCompare(b.start));
  }
  private async cacheMail(owner: string, mail: Mail[], connectionId: string) {
    const imports = await this.db.list<{ id: string; artifactId: string; connectionId?: string }>(
      owner,
      "imports",
    );
    const result = mail.map((message) => ({
      ...message,
      attachments: message.attachments.map(
        (ref) =>
          imports.find((i) => i.id === ref && i.connectionId === connectionId)?.artifactId ?? ref,
      ),
    }));
    for (const message of result) await this.db.put(owner, "mail", { ...message, connectionId });
    return result;
  }
  async thread(owner: string, id: string) {
    const connection = await this.connection(owner);
    if (!connection) throw new AppError("Google is disconnected", 409);
    const mail =
      this.config.mode === "sample"
        ? (await this.db.list<Mail>(owner, "mail")).filter((m) => m.threadId === id)
        : await this.cacheMail(
            owner,
            await this.google(owner, connection.id).getThread(id),
            connection.id,
          );
    if (!mail.length) throw new AppError("Mail thread not found", 404);
    return mail.sort((a, b) => a.date.localeCompare(b.date));
  }
  async searchMail(owner: string, query: string) {
    const connection = await this.connection(owner);
    if (!connection) throw new AppError("Google is disconnected", 409);
    if (this.config.mode === "live")
      return this.cacheMail(
        owner,
        await this.google(owner, connection.id).listMail(query || "in:inbox"),
        connection.id,
      );
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return (await this.db.list<Mail>(owner, "mail"))
      .filter(
        (message) =>
          !/^Sent\b/i.test(message.label) &&
          words.every((word) =>
            `${message.sender} ${message.from} ${message.subject} ${message.body}`
              .toLowerCase()
              .includes(word),
          ),
      )
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  async ensureSample(owner: string, actions: ActionService) {
    if (this.config.mode !== "sample") return;
    const active = this.seeding.get(owner);
    if (active) return active;
    const task = this.seed(owner, actions).finally(() => this.seeding.delete(owner));
    this.seeding.set(owner, task);
    await task;
  }
  private sampleAccount() {
    return sampleProfile(this.config.openroadsPersona);
  }
  private async seed(owner: string, actions: ActionService) {
    if (await this.db.get(owner, "settings", "seeded")) return;
    if (this.config.openroadsPersona?.trim()) await this.seedFreight(owner);
    else await this.seedSchool(owner, actions);
    await this.db.put(owner, "settings", { id: "google", enabled: true });
    await this.db.put(owner, "settings", { id: "seeded", value: true });
  }
  private async seedFreight(owner: string) {
    const account = this.sampleAccount().email;
    const file = await this.files.import(
      owner,
      "Carrier Profile & Setup Form.pdf",
      await createCarrierProfilePdf(),
      "Mail · Northline Haul LLC",
    );
    const now = new Date();
    const at = (dayOffset: number, hour: number, minute = 0) => {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hour, minute, 0, 0);
      return d;
    };
    const onWeekday = (weekday: number, hour: number, minute = 0) => {
      const d = at(0, hour, minute);
      const delta = (weekday - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + delta);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 7);
      return d;
    };
    const nextWeekday = (weekday: number) => {
      const d = new Date(now);
      const delta = (weekday - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + delta);
      return d.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    };
    const inDays = (days: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() + days);
      return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    };
    const mails: Mail[] = [
      {
        id: "mail-carrier-packet",
        threadId: "carrier-packet-thread",
        sender: "Priya Nandakumar",
        from: "dispatch@northline.test",
        to: [account],
        subject: "New carrier setup packet",
        body: [
          "Hi,",
          "",
          "Please complete the attached carrier setup packet. It is a PDF form for Northline Haul LLC, a fictional carrier.",
          "",
          "Legal name: Northline Haul LLC",
          "DBA: Northline",
          "MC number: MC-884211",
          "USDOT number: 3901844",
          "Contact name: Priya Nandakumar",
          "Phone: 312-555-0148",
          "Email: dispatch@northline.test",
          "Equipment type: Dry van",
          "Number of trucks: 18",
          "Insurer: Harbor Mutual",
          "Policy number: HM-22910",
          "Auto liability limit: $1,000,000",
          "COI expiration date: June 1, 2027",
          "Quick pay requested: yes",
          "Signature name: Priya Nandakumar",
          "Signature date: September 28, 2026",
          "",
          "Cargo limit and remit-to address were left out of this packet. Please ask us for those before sending the completed form back.",
          "",
          "Thank you,",
          "Priya Nandakumar",
          "Northline Haul LLC",
          "",
          "This message is fictional sample data.",
        ].join("\n"),
        date: at(0, 8, 40).toISOString(),
        unread: true,
        label: "Carriers",
        attachments: [file.id],
      },
      {
        id: "mail-pod",
        threadId: "pod-thread",
        sender: "Southbend Dock",
        from: "dock@southbend.test",
        to: [account],
        subject: "POD for load #JA-48213",
        body: [
          "Load #JA-48213 was delivered to the consignee.",
          "",
          "Exception: 2 pallets short.",
          "Consignee: Lakeside Goods (fictional)",
          "Lane: Chicago, IL to Atlanta, GA",
          "",
          "Please flag the shortage before the POD is closed.",
          "",
          "This message is fictional sample data.",
        ].join("\n"),
        date: at(0, 8, 12).toISOString(),
        unread: true,
        label: "POD",
        attachments: [],
      },
      {
        id: "mail-quote",
        threadId: "quote-thread",
        sender: "Morgan Hale",
        from: "shipping@lakeside-goods.example.com",
        to: [account],
        subject: "Shipper quote request: Chicago to Atlanta",
        body: [
          "Please quote this freight.",
          "",
          "Origin: Chicago, IL",
          "Destination: Atlanta, GA",
          "Mode: dry van FTL",
          "Weight: 42,000 lb",
          `Pickup: next Tuesday, ${nextWeekday(2)}`,
          "",
          "Lakeside Goods is a fictional shipper.",
          "",
          "This message is fictional sample data.",
        ].join("\n"),
        date: at(0, 7, 55).toISOString(),
        unread: true,
        label: "Quotes",
        attachments: [],
      },
      {
        id: "mail-invoice",
        threadId: "invoice-thread",
        sender: "Red Cedar Transport",
        from: "billing@redcedar.test",
        to: [account],
        subject: "Carrier invoice for load #JA-48190",
        body: [
          "Red Cedar Transport LLC (fictional) submitted an invoice for load #JA-48190.",
          "",
          "Detention claimed: 3 hours",
          "Check-in: September 28, 2026, 8:10 AM",
          "Check-out: September 28, 2026, 2:40 PM",
          "Amount claimed: $225",
          "",
          "Please check the dwell time before approving payment.",
          "",
          "This message is fictional sample data.",
        ].join("\n"),
        date: at(0, 7, 20).toISOString(),
        unread: true,
        label: "Billing",
        attachments: [],
      },
      {
        id: "mail-coi",
        threadId: "coi-thread",
        sender: "Harbor Mutual",
        from: "certificates@harbor-mutual.test",
        to: [account],
        subject: "Insurance certificate expiring in 21 days",
        body: [
          "The certificate of insurance for an existing carrier, Red Cedar Transport LLC (fictional), expires in 21 days.",
          "",
          `COI expiration: ${inDays(21)}`,
          "MC number: MC-102884",
          "Policy number: HM-10442",
          "",
          "Please review the COI before it lapses.",
          "",
          "This message is fictional sample data.",
        ].join("\n"),
        date: at(-1, 16, 5).toISOString(),
        unread: false,
        label: "Insurance",
        attachments: [],
      },
      {
        id: "mail-quickpay",
        threadId: "quickpay-thread",
        sender: "Northline Haul LLC",
        from: "payables@northline.test",
        to: [account],
        subject: "Quick-pay request for load #JA-48177",
        body: [
          "Please process quick pay for load #JA-48177.",
          "",
          "Carrier: Northline Haul LLC (fictional)",
          "Amount: $1,840",
          "Remit-to is already on file for this load.",
          "",
          "This message is fictional sample data.",
        ].join("\n"),
        date: at(-1, 11, 30).toISOString(),
        unread: true,
        label: "Billing",
        attachments: [],
      },
    ];
    for (const mail of mails) await this.db.put(owner, "mail", mail);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const review = onWeekday(4, 15);
    const onboarding = at(1, 11);
    const standup = onWeekday(1, 9);
    for (const event of [
      {
        id: "event-shipper-review",
        calendarId: "primary",
        title: "Shipper quarterly review",
        start: review.toISOString(),
        end: new Date(review.getTime() + 60 * 60000).toISOString(),
        allDay: false,
        timeZone: zone,
        location: "Chicago office",
        description: "Quarterly review with fictional shipper Lakeside Goods.",
        attendees: ["shipping@lakeside-goods.example.com"],
      },
      {
        id: "event-onboarding-call",
        calendarId: "primary",
        title: "Carrier onboarding call",
        start: onboarding.toISOString(),
        end: new Date(onboarding.getTime() + 30 * 60000).toISOString(),
        allDay: false,
        timeZone: zone,
        location: "Phone",
        description: "Onboarding call with fictional carrier Northline Haul LLC.",
        attendees: ["dispatch@northline.test"],
      },
      {
        id: "event-billing-standup",
        calendarId: "primary",
        title: "Monday billing standup",
        start: standup.toISOString(),
        end: new Date(standup.getTime() + 30 * 60000).toISOString(),
        allDay: false,
        timeZone: zone,
        location: "Billing desk",
        description: "Monday billing standup for open detention, quick pay, and COI items.",
        attendees: [],
      },
    ])
      await this.db.put(owner, "events", event);
  }
  private async seedSchool(owner: string, actions: ActionService) {
    const account = this.sampleAccount().email;
    const file = await this.files.import(
      owner,
      "Field trip permission slip.pdf",
      await createSamplePdf(),
      "Gmail · Lincoln Middle School",
    );
    const now = new Date();
    const at = (h: number, m = 0) => {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    const mails: Mail[] = [
      {
        id: "mail-fieldtrip",
        threadId: "trip-thread",
        sender: "Lincoln Middle School",
        from: "office@lincoln.example",
        to: [account],
        subject: "A little reminder: permission slips are due Friday",
        body: "Hi Alex,\n\nOur class is heading to the aquarium this Friday. Please complete the attached permission slip and send it back when you have a moment.\n\nWe’ll leave school at 8:15 AM and return by 4:30 PM. Please pack lunch and a water bottle.\n\nThank you!\nMs. Rivera\n\nThis message is included with your local workspace.",
        date: at(8, 42),
        unread: true,
        label: "School",
        attachments: [file.id],
      },
      {
        id: "mail-design",
        threadId: "design-thread",
        sender: "Jamie Chen",
        from: "jamie@example.com",
        to: [account],
        subject: "Coffee and a catch-up?",
        body: "Hey Alex,\n\nWould love to catch up this week. I’m free Thursday afternoon. How does 3 PM at Bluebird Coffee sound?\n\nJamie\n\nThis invitation is part of your local workspace.",
        date: at(8, 15),
        unread: true,
        label: "Personal",
        attachments: [],
      },
      {
        id: "mail-stay",
        threadId: "stay-thread",
        sender: "The Seabird",
        from: "stay@seabird.example",
        to: [account],
        subject: "Your weekend, all sorted",
        body: "Your reservation is confirmed.\n\nCheck-in: Friday, 3 PM\nCheck-out: Sunday, 11 AM\n\nThis fictional reservation demonstrates how OpenRoads can organize travel details.",
        date: at(7, 30),
        unread: false,
        label: "Travel",
        attachments: [],
      },
      {
        id: "mail-studio",
        threadId: "studio-thread",
        sender: "Studio North",
        from: "hello@studionorth.example",
        to: [account],
        subject: "Notes from our last conversation",
        body: "Thanks for a thoughtful conversation yesterday. Let’s use our next session to review the prototype and pick the three flows for testing.\n\nThis project is part of your local workspace.",
        date: new Date(now.getTime() - 86400000).toISOString(),
        unread: false,
        label: "Work",
        attachments: [],
      },
    ];
    for (const mail of mails) await this.db.put(owner, "mail", mail);
    const base = {
      calendarId: "primary",
      allDay: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      description: "A little time to catch up",
      attendees: [],
    };
    for (const event of [
      {
        ...base,
        id: "event-standup",
        title: "A slow start · morning walk",
        start: at(9),
        end: at(9, 30),
        location: "Neighborhood",
      },
      {
        ...base,
        id: "event-review",
        title: "Design catch-up",
        start: at(11),
        end: at(11, 45),
        location: "Studio North",
      },
      {
        ...base,
        id: "event-lunch",
        title: "Lunch with Maya",
        start: at(13),
        end: at(14),
        location: "Little Saint",
      },
    ])
      await this.db.put(owner, "events", event);
    await actions.propose(owner, {
      kind: "calendar.create",
      data: {
        ...base,
        title: "Coffee with Jamie",
        start: at(15),
        end: at(16),
        location: "Bluebird Coffee",
        description: "Catch up over coffee",
        attendees: ["jamie@example.com"],
      },
    });
  }
  async snapshot(owner: string, query?: string): Promise<Workspace> {
    let mail: Mail[], events: CalendarEvent[];
    const connected = await this.connected(owner);
    if (this.config.mode === "live" && connected) {
      const connection = await this.connection(owner);
      if (!connection) throw new AppError("Google is disconnected", 409);
      const google = this.google(owner, connection.id);
      [mail, events] = await Promise.all([google.listMail(query), google.listEvents()]);
      mail = await this.cacheMail(owner, mail, connection.id);
      for (const event of events) await this.db.put(owner, "events", event);
    } else if (this.config.mode === "sample" && connected) {
      mail = await this.db.list<Mail>(owner, "mail");
      events = await this.db.list<CalendarEvent>(owner, "events");
      if (query)
        mail = mail.filter((m) =>
          `${m.sender} ${m.subject} ${m.body}`.toLowerCase().includes(query.toLowerCase()),
        );
    } else {
      mail = [];
      events = [];
    }
    const tokens = this.config.mode === "live" ? await this.googleAuth.tokens(owner) : null;
    const sample = this.sampleAccount();
    return {
      mode: this.config.mode,
      profile: {
        name: this.config.mode === "sample" ? sample.name : "You",
        email: tokens?.account ?? (this.config.mode === "sample" ? sample.email : ""),
      },
      mail: mail.sort((a, b) => b.date.localeCompare(a.date)),
      events: events.sort((a, b) => a.start.localeCompare(b.start)),
      files: await this.files.list(owner),
      browsers: await this.db.list<BrowserSession>(owner, "browsers"),
      actions: await this.db.list<ActionProposal>(owner, "actions"),
      activity: await this.db.list<ActivityEntry>(owner, "activity"),
      connections: [
        {
          id: "google",
          name: "Google",
          status: connected
            ? this.config.mode === "sample"
              ? "sample"
              : "connected"
            : "disconnected",
          account: tokens?.account ?? (this.config.mode === "sample" ? sample.email : undefined),
          capabilities:
            this.config.mode === "sample" ? ["Gmail", "Calendar"] : (tokens?.scopes ?? []),
        },
        {
          id: "browser",
          name: "Browser",
          status: this.config.workerUrl && this.config.workerToken ? "connected" : "unconfigured",
          capabilities: ["Persistent sessions", "PDF downloads"],
        },
        {
          id: "openbot",
          name: "OpenBot",
          status: "unconfigured",
          capabilities: ["Integration adapter available"],
        },
      ],
      runtime: {
        provider: this.config.agentBackend === "sample" ? "sample" : "model",
        configured: agentConfigured(this.config),
        openbotConfigured: false,
        richThreads: true,
      },
    };
  }
  async prepare(owner: string, input: ProposalInput, connectionId?: string) {
    if (input.kind === "email.send") {
      for (const id of input.data.attachmentIds) await this.files.get(owner, id);
      return { input };
    }
    if (input.kind === "calendar.create" || this.config.mode === "sample") return { input };
    const reviewed = await this.google(owner, connectionId).reviewEvent(
      input.data.calendarId,
      input.data.eventId,
    );
    return {
      input:
        input.kind === "calendar.delete"
          ? { ...input, data: { ...input.data, title: reviewed.event.title } }
          : input,
      target: reviewed.event,
      targetVersion: reviewed.version,
    };
  }
  async execute(
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ): Promise<string> {
    if (this.config.mode === "sample") {
      if (input.kind === "email.send") {
        const id = randomUUID();
        await this.db.put(owner, "mail", {
          id,
          threadId: input.data.threadId ?? id,
          sender: "You",
          from: this.sampleAccount().email,
          to: input.data.to,
          subject: input.data.subject,
          body: input.data.body,
          date: new Date().toISOString(),
          unread: false,
          label: "Sent · local",
          attachments: input.data.attachmentIds,
        });
        return `Saved to local sent mail · ${id}`;
      }
      if (input.kind === "calendar.delete") {
        await this.db.remove(owner, "events", input.data.eventId);
        return "Removed from local calendar";
      }
      const id = input.kind === "calendar.update" ? input.data.eventId : randomUUID();
      await this.db.put(owner, "events", { ...input.data, id });
      return `Saved to local calendar · ${id}`;
    }
    const tokens = await this.googleAuth.tokens(owner);
    if (!tokens) throw new AppError("Google is disconnected", 409);
    const capability = input.kind === "email.send" ? "gmail.send" : "calendar.events";
    if (!tokens.scopes.includes(`https://www.googleapis.com/auth/${capability}`))
      throw new AppError("Enable Google write access in Connections before approving", 403);
    if (tokens.connectionId !== connectionId)
      throw new AppError("Google account or connection changed. Prepare a new action.", 409);
    const google = this.google(owner, connectionId);
    if ((input.kind === "calendar.update" || input.kind === "calendar.delete") && !targetVersion)
      throw new AppError(
        "This calendar review predates target-version checks. Prepare a new review.",
        409,
      );
    if (input.kind === "email.send") {
      const attachments = await Promise.all(
        input.data.attachmentIds.map(async (id) => {
          const file = await this.files.get(owner, id);
          return {
            name: file.name,
            mimeType: file.mimeType,
            bytes: await this.files.bytes(owner, id),
          };
        }),
      );
      const receipt = await google.sendEmail(input.data, attachments);
      return `Gmail sent message · ${receipt.id}`;
    }
    if (input.kind === "calendar.delete") {
      await google.deleteEvent(input.data.calendarId, input.data.eventId, targetVersion);
      await this.db.remove(owner, "events", input.data.eventId);
      return `Deleted Google Calendar event · ${input.data.eventId}`;
    }
    const event =
      input.kind === "calendar.create"
        ? await google.createEvent(input.data)
        : await google.updateEvent(input.data.eventId, input.data, targetVersion);
    await this.db.put(owner, "events", event);
    return `Google Calendar event · ${event.id}`;
  }
  async importAttachment(owner: string, reference: string): Promise<Artifact> {
    const connection = await this.connection(owner);
    if (!connection) throw new AppError("Google is disconnected", 409);
    const cached = await this.db.get<{ artifactId: string; connectionId?: string }>(
      owner,
      "imports",
      reference,
    );
    if (cached && cached.connectionId === connection.id)
      return this.files.signed(owner, await this.files.get(owner, cached.artifactId));
    const [messageId, attachmentId, filename] = reference.split(":");
    if (!messageId || !attachmentId || !filename)
      throw new AppError("Attachment reference is invalid");
    const message = await this.db.get<Mail & { connectionId?: string }>(owner, "mail", messageId);
    if (!message?.attachments.includes(reference) || message.connectionId !== connection.id)
      throw new AppError("Attachment not found. Refresh the current account's inbox.", 404);
    const file = await this.files.import(
      owner,
      decodeURIComponent(filename),
      await this.google(owner, connection.id).getAttachment(messageId, attachmentId),
      `Gmail · ${message.subject}`,
    );
    await this.db.put(owner, "imports", {
      id: reference,
      artifactId: file.id,
      connectionId: connection.id,
    });
    return file;
  }
}
