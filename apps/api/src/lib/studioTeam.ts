import { SEATS, type Seat, type UserRole } from '@janelle/shared';

/**
 * The studio's own people and addresses, as the studio listed them.
 *
 * Accounts (`profiles`) remain the source of truth for who can sign in and
 * who a task can be given to. This list covers what an account cannot:
 *
 * - A teammate with no account yet is still a teammate. Three of them write
 *   from personal Gmail addresses, and without this their mail read as a
 *   client's — their names became client names, their addresses vendor
 *   contacts.
 * - A shared mailbox is the studio, not a person. systems@ signs in and
 *   connects Gmail, but nobody reads a task given to it, and an account named
 *   "Janelle (Admin)" made "give it to Janelle" a coin toss between it and
 *   Janelle herself.
 * - The roles document spells a name one way and the account another.
 *
 * Kept on the server: the Gmail addresses are personal and the web bundle is
 * public. When someone joins or leaves, change it here and on Team & roles.
 */

export interface StudioPerson {
  name: string;
  email: string;
  /** The seat the roles document names them for; null when it names none. */
  seat: Seat | null;
  /** Other spellings people use for them, in documents or aloud. */
  aliases?: string[];
  /** Other addresses they write from. */
  otherEmails?: string[];
}

/** How the studio names itself on paper. */
export const STUDIO_NAME = 'Janelle Interiors';

/**
 * The letterhead, read off the studio's own Houzz Pro purchase orders.
 *
 * A purchase order is a document with a sender, and drafting one from a form
 * meant the address, the phone number and the correspondence mailbox were
 * either typed again each time or left as [Studio Name]. They do not change
 * between orders, so they are not questions to ask.
 *
 * `correspondence` is where vendors are told to write — the monitored inbox,
 * not whichever teammate pressed Run, and not the shared account Gmail is
 * connected through.
 */
export const STUDIO_LETTERHEAD = {
  name: STUDIO_NAME,
  address: ['221 E. Matilija St, Unit B', 'Ojai, California 93023'],
  website: 'www.janelleinteriors.com',
  phone: '805.640.0194',
  correspondence: 'info@janelleinteriors.com',
  /** How the studio signs a purchase order. */
  signOff: 'Janelle Interiors Design Team',
} as const;

/** Any address here is the studio writing, whoever signs it. */
export const STUDIO_DOMAINS = ['janelleinteriors.com'];

/** Shared inboxes: the studio itself — never a person, client, vendor or owner. */
export const STUDIO_MAILBOXES = ['systems@janelleinteriors.com'];

export const STUDIO_TEAM: StudioPerson[] = [
  { name: 'Janelle Kandziora', email: 'janelle@janelleinteriors.com', seat: 'owner' },
  { name: 'Carissa Kolbeck', email: 'carissa@janelleinteriors.com', seat: 'operations' },
  { name: 'Joanna Ramos', email: 'joanna@janelleinteriors.com', seat: 'pm_support', otherEmails: ['ramos.joannaeve@gmail.com'] },
  { name: 'Victoria Manayan', email: 'victoria@janelleinteriors.com', seat: 'technical_production', otherEmails: ['manayan.victoriam@gmail.com'] },
  { name: 'Adeleigh McGee', email: 'adeleigh@janelleinteriors.com', seat: 'hotel_ffe', aliases: ['Adelaide McGee'] },
  { name: 'Brianna Johnson', email: 'brianna@janelleinteriors.com', seat: 'design' },
];

/** The bare address out of "Name <address>", lower-cased; '' when there is none. */
export function addressOf(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  const angled = text.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : text).trim().toLowerCase();
  return address.includes('@') ? address : '';
}

export function isStudioMailbox(raw: string | null | undefined): boolean {
  const address = addressOf(raw);
  return !!address && STUDIO_MAILBOXES.includes(address);
}

/** Written by the studio: its domain, a shared inbox, or a teammate's own address. */
export function isStudioAddress(raw: string | null | undefined): boolean {
  const address = addressOf(raw);
  if (!address) return false;
  return (
    STUDIO_DOMAINS.includes(address.split('@')[1]) ||
    STUDIO_MAILBOXES.includes(address) ||
    STUDIO_TEAM.some((p) => p.email === address || p.otherEmails?.includes(address))
  );
}

/**
 * Software the studio runs on, which writes a great deal of email and is
 * never a vendor, a client or a project: Slack's welcome, GitHub's codes,
 * Vercel's deploys. Their names came back as vendor hints.
 */
const SOFTWARE = [
  'slack', 'github', 'vercel', 'dropbox', 'google', 'gmail', 'google drive', 'google docs', 'houzz', 'houzz pro',
  'canva', 'quickbooks', 'intuit', 'zoom', 'docusign', 'supabase', 'notion', 'asana', 'trello', 'microsoft',
  'outlook', 'linkedin', 'facebook', 'instagram', 'mailchimp', 'stripe', 'paypal', 'calendly', 'copilot',
];

export function isSoftwareService(raw: string | null | undefined): boolean {
  const said = plain(raw ?? '');
  if (!said) return false;
  return SOFTWARE.some((name) => said === name || said.startsWith(`${name} `));
}

/** A sender nobody answers: no-reply, notifications, mailer daemons. */
export function isAutomatedAddress(raw: string | null | undefined): boolean {
  const address = addressOf(raw);
  if (!address) return false;
  const local = address.split('@')[0];
  return /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|mailer[-_.]?daemon|postmaster|bounce|alerts?|updates?|news(letter)?|marketing|messages\+)/.test(local)
    || /(^|\.)(noreply|no-reply)\./.test(address.split('@')[1] ?? '');
}

/**
 * A job name with the teammate who ordered it, and when, taken off the front.
 *
 * Vendors write the sidemark they are given, and the studio gives "Carissa
 * 90826/Oak Kit": Carissa's order of 9 August 2026 for the Oak Kitchen. The
 * job is the part after the slash. Only that exact shape is changed — a
 * teammate's first name, a number, a slash — so a client who shares a first
 * name with a teammate keeps their project name.
 */
export function orderedByTeammate(name: string): string {
  const firstNames = STUDIO_TEAM.flatMap((p) => [p.name, ...(p.aliases ?? [])].map((n) => n.split(' ')[0]));
  const m = name.match(/^\s*([A-Za-z]+)\s+\d[\d-]*\s*\/\s*(.+)$/);
  if (!m) return name;
  return firstNames.some((f) => f.toLowerCase() === m[1].toLowerCase()) ? m[2].trim() : name;
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The studio's own name or a teammate's full name — never a client, a vendor
 * or a project, however an email or a document puts it.
 */
export function isStudioName(raw: string | null | undefined): boolean {
  const said = plain(raw ?? '');
  if (!said) return false;
  if (said === plain(STUDIO_NAME) || said.startsWith(`${plain(STUDIO_NAME)} `)) return true;
  return STUDIO_TEAM.some((p) => [p.name, ...(p.aliases ?? [])].some((n) => plain(n) === said));
}

/** The teammate an address or a full name belongs to, if the list has them. */
export function studioPerson(said: { email?: string | null; name?: string | null }): StudioPerson | null {
  const address = addressOf(said.email);
  if (address) {
    const byEmail = STUDIO_TEAM.find((p) => p.email === address || p.otherEmails?.includes(address));
    if (byEmail) return byEmail;
  }
  const name = (said.name ?? '').trim().toLowerCase();
  if (!name) return null;
  return STUDIO_TEAM.find((p) => [p.name, ...(p.aliases ?? [])].some((n) => n.toLowerCase() === name)) ?? null;
}

/** Every name a teammate goes by: the full name first, then the other spellings. */
export function namesFor(person: { full_name: string; email?: string | null }): string[] {
  const known = studioPerson({ email: person.email, name: person.full_name });
  return [person.full_name, ...(known ? [known.name, ...(known.aliases ?? [])] : [])]
    .filter((name, i, all) => all.findIndex((n) => n.toLowerCase() === name.toLowerCase()) === i);
}

/** The access a teammate's seat implies; null when they hold no seat. */
export function seatRole(person: StudioPerson): UserRole | null {
  return person.seat ? SEATS[person.seat].role : null;
}
