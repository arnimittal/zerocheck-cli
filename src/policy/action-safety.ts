import { keyActivatesControl, normalizeKey } from '../../shared/keyboard.js';

export type ActionSafetyVerdict = 'allow' | 'log' | 'deny';
export type ActionSafetyEnvironment = 'dev' | 'staging' | 'production' | 'unknown';

export interface ActionSafetyDecision {
  verdict: ActionSafetyVerdict;
  category: string;
  reason: string;
  sideEffect?: boolean;
}

export interface ActionSafetyInput {
  environment?: ActionSafetyEnvironment;
  currentUrl: string;
  startUrl?: string;
  actionType: string;
  role?: string | null;
  name?: string | null;
  label?: string | null;
  text?: string | null;
  href?: string | null;
  inputType?: string | null;
  labels?: string | null;
  placeholder?: string | null;
  formPurpose?: string | null;
  confirmationContext?: string | null;
  /** Observed submission facts; not nearby form prose or another button's action. */
  isSubmission?: boolean;
  nativeDialogDismissal?: boolean;
  submitterName?: string | null;
  formAction?: string | null;
  selectedOption?: string | null;
  bulkScope?: boolean;
  proposedValue?: string | null;
  proposedNavigationTarget?: string | null;
}

/** Pure local policy. Target/origin/credential proof remains the executor's responsibility. */
export function evaluateActionSafety(input: ActionSafetyInput): ActionSafetyDecision {
  return decide(input);
}

const DESTRUCTIVE = /\b(?:delet(?:e|es|ing|ion)|remov(?:e|es|ing|al)|drop(?:s|ping)?|wip(?:e|es|ing)|purg(?:e|es|ing)|truncat(?:e|es|ing|ion)|destroy(?:s|ing)?|destruction|reset(?:s|ting)?|eras(?:e|es|ing|ure))\b/i;
const CLOSING = /\b(?:clos(?:e|es|ing|ure)|deactivat(?:e|es|ing|ion)|disabl(?:e|es|ing)|archiv(?:e|es|ing))\b/i;
const ACCESS = /\b(?:revok(?:e|es|ing)|revocation|remov(?:e|es|ing|al)|disabl(?:e|es|ing)|deactivat(?:e|es|ing|ion))\b/i;
const HARD_OBJECT = /\b(?:accounts?|workspaces?|tenants?|orgs?|organi[sz]ations?|projects?|production resources?)\b/i;
const HARD_DATA = /\b(?:databases?|dbs?|production data|customer data|all data)\b/i;
const HARD_ACCESS = /\b(?:critical access|admin access|owner access|all (?:users|members|teammates))\b/i;
const FINANCIAL_DESTRUCTION = /\b(?:cancel(?:s|ling|ing|lation)?|terminat(?:e|es|ing|ion)|void(?:s|ing)?|refund(?:s|ing)?|chargebacks?)\b/i;
const FINANCIAL_OBJECT = /\b(?:subscriptions?|plans?|payments?|invoices?|contracts?)\b/i;
const SEND = /\b(?:invit(?:e|es|ing|ation)|email(?:s|ing)?|messag(?:e|es|ing)|send(?:s|ing)?|sent|notif(?:y|ies|ied|ying|ication)|sms|broadcast(?:s|ing)?)\b/i;
const BULK_SCOPE = /\b(?:all|every|everyone|everybody|bulk|entire)\b|\b(?:\d[\d,]*\s+selected|selected\s+(?:\d[\d,]*|items|entries|records|recipients|users|members|customers|contacts|subscribers))\b/i;
const PLURAL_RECIPIENTS = /\b(?:customers|users|contacts|subscribers|recipients|members)\b/i;
const DURABLE_SECRET = /\b(?:api (?:keys?|tokens?|credentials?)|(?:personal )?access tokens?|private keys?|signing keys?|recovery codes?|secret exports?|client secrets?|webhook secrets?|service account keys?)\b/i;
const AUTH = /\b(?:password|passcode|security code|verification code|otp|one time (?:passcode|password|code)|mfa|2fa)\b/i;
const PAYMENT_FIELD = /\b(?:card number|credit card|debit card|cvc|cvv|expiry|expiration|payment method|saved card)\b/i;
const FINANCIAL_FLOW = /\b(?:pay now|pay invoice|submit payment|place order|complete purchase|complete order|confirm order|submit checkout|buy now|purchase|subscribe|start trial|upgrade)\b/i;
const DISMISSAL = /^(?:cancel|back|close|dismiss|no|no thanks|never mind|×|✕|x)[.!]?$/i;
const GENERIC = /^(?:yes|ok|okay|confirm|continue|next|done|finish|complete|save(?: changes)?|submit|apply|proceed|accept|remove|delete|reset|cancel|close|erase|purge|wipe|refund|void|send|invite|email|notify)[.!]?$/i;
const BARE_HAZARD = /^(?:delete|erase|purge|wipe|truncate|destroy|drop|revoke|refund|void)(?: all| selected)?[.!]?$/i;
const HAZARD_CONTEXT = /\b(?:erasure|deletion|destruction|deactivation|termination|revocation|purging|permanent (?:removal|closure))\b/i;
const SEARCH = /^search(?:\s+.*)?$/i;
const PRIVATE_DATA = /\b(?:export|download|view)\b.*\b(?:customer data|users csv|report|invoice|billing data)\b/i;
const RESOURCE = /\b(?:accounts?|workspaces?|tenants?|orgs?|organi[sz]ations?|projects?|databases?|dbs?|users?|members?|payments?|invoices?|subscriptions?|plans?|contracts?|attachments?|filters?|coupons?|items?|orders?|files?|tasks?|comments?|entries|entry|passwords?|trash)\b/i;

function decide(input: ActionSafetyInput): ActionSafetyDecision {
  const action = input.actionType.toLowerCase();
  const names = unique([input.name, input.label, input.text, input.labels, input.placeholder]);
  const name = names[0] ?? '';
  const key = normalizeKey(input.proposedValue ?? undefined).key.toLowerCase();
  const press = action === 'press' && keyActivatesControl(input.proposedValue ?? undefined, input.role, input.inputType);
  const activation = action === 'click' || press;
  const submission = input.isSubmission === true;
  const option = action === 'select' ? words(input.selectedOption ?? '') : '';
  const destructiveKey = action === 'press' && /^(?:delete|backspace)$/.test(key) && !input.inputType && !['textbox', 'searchbox'].includes(input.role ?? '');
  const operates = activation || action === 'navigate' || Boolean(option) || destructiveKey;
  const destinations = [action === 'navigate' ? input.proposedNavigationTarget : activation ? input.href : undefined, submission ? input.formAction : undefined];
  const operations = destinations.flatMap(target => urlOperations(target, input.currentUrl));
  const direct = [...names, ...(option ? [option] : []), ...(destructiveKey ? names.map(fact => `delete ${fact}`) : []), ...(submission ? unique([input.submitterName]) : []), ...operations];
  if (operates) {
    for (const fact of direct) { const denied = hardStop(fact, input.bulkScope === true); if (denied) return denied; }
    if (operations.some(fact => BARE_HAZARD.test(fact.trim()))) return deny('unresolved_hazard', 'Observed hazardous URL operation has no identified object');
    if (option && (BARE_HAZARD.test(option) || input.bulkScope && (DESTRUCTIVE.test(option) || CLOSING.test(option)))) {
      return deny('destructive', 'Destructive operation selection is blocked');
    }
  }
  // Native dialog submission is independently observed dismissal semantics.
  if (activation && input.nativeDialogDismissal && DISMISSAL.test(name)) return allow('dismissal', 'Native dialog dismissal does not submit an external operation');
  const ownedContext = unique([input.confirmationContext, input.formPurpose]).map(prospectiveOperation);
  const needsObject = [DESTRUCTIVE, CLOSING, ACCESS, FINANCIAL_DESTRUCTION].some(pattern => pattern.test(name)) && !RESOURCE.test(name);
  const generic = GENERIC.test(name) || DISMISSAL.test(name) && !input.href || needsObject;
  const context = generic || submission && !name ? ownedContext : [];
  // Explicit bulk operation scope remains relevant even for a named CTA.
  if (operates && ownedContext.some(fact => BULK_SCOPE.test(fact) || hasBulkRecipientDeclaration(fact)) && direct.some(fact => SEND.test(fact) || DESTRUCTIVE.test(fact))) return deny('bulk_side_effect', 'Bulk external or destructive operations are blocked');
  if (operates) {
    for (const fact of context) { const denied = hardStop(fact, input.bulkScope === true, generic); if (denied) return denied; }
    // A bare operation needs its observed object; do not splice a qualified benign
    // control such as Remove attachment together with unrelated account prose.
    if (generic) {
      for (const fact of context) { const denied = hardStop(`${name} ${fact}`, input.bulkScope === true); if (denied) return denied; }
    }
    if (activation && (BARE_HAZARD.test(name) || context.some(fact => HAZARD_CONTEXT.test(fact))) && !context.some(fact => RESOURCE.test(fact))) {
      return deny('unresolved_hazard', 'Observed hazardous activation lacks a permitted operation context');
    }
  }
  const typingSearch = action === 'fill' && (input.inputType === 'search' || SEARCH.test(name));
  const secretContext = [...direct, ...(!typingSearch ? ownedContext : []),
    ...destinations.filter((target): target is string => Boolean(target)).map(target => urlPath(target, input.currentUrl)),
    ...(!typingSearch && !input.href && action !== 'navigate' && /\b(?:reveal|show|view|copy|export|download|generate|create|roll|rotate|regenerate|revoke|delete)\b/i.test(name) ? [urlPath(input.currentUrl, input.currentUrl)] : [])];
  if (input.environment === 'production' && !['scroll','wait'].includes(action) && (action !== 'hover' || direct.some(fact => DURABLE_SECRET.test(fact)) || /\b(?:reveal|show|view)\b/i.test(name)) && secretContext.some(fact => DURABLE_SECRET.test(fact) || /\b(?:tokens?|secrets?|keys?)\b/i.test(fact) && /\b(?:reveal|show|view|copy|export|download|generate|create|roll|rotate|regenerate|revoke|delete)\b/i.test(name))) {
    return deny('production_secret', 'Production durable secret exposure or mutation is blocked');
  }
  if (['scroll','hover','wait'].includes(action)) return allow('normal_observation', 'Read-only observation does not activate the control');
  if (action === 'navigate') return external(input.proposedNavigationTarget, input.startUrl ?? input.currentUrl)
    ? log('external_navigation','Permitted-origin navigation is recorded',false) : allow('normal_navigation','Navigation remains subject to the separate origin policy');
  if (input.inputType === 'file') return log('file_upload','File entry is recorded and may require a fixture',false);
  if (action === 'fill' || action === 'select') {
    if (input.inputType === 'password' || names.some(fact=>AUTH.test(fact))) return allow('normal_auth_flow','Password and OTP entry is normal product flow');
    if (names.some(fact=>PAYMENT_FIELD.test(fact))) return log('payment_entry','Payment field entry is allowed and recorded',false);
    return option ? log('routine_test_side_effect','Operation selection is allowed and recorded',true) : allow('normal_form_fill','Field entry is normal product flow');
  }
  if (action === 'press' && !press && !destructiveKey && (input.inputType || ['textbox','searchbox'].includes(input.role ?? ''))) return allow('normal_input_key','Non-submitting input key is normal field interaction');
  if (direct.some(fact=>FINANCIAL_FLOW.test(fact))) return log('financial','Payment and checkout are permitted product flows, not proof of test mode',true);
  if (direct.some(fact=>PRIVATE_DATA.test(fact))) return log('private_data','Private-data action is recorded',true);
  if (activation && input.href && !submission) return log(external(input.href,input.startUrl??input.currentUrl)?'external_navigation':'same_origin_navigation','Navigation activation is recorded; hidden effects are not assumed harmless',true);
  // Unfamiliar customer controls do not need a keyword whitelist or remote permission.
  return log('routine_test_side_effect','Product activation is recorded with conservative possible-mutation accounting',true);
}

function hardStop(fact: string, bulk: boolean, pluralRecipients = true): ActionSafetyDecision | undefined {
  bulk ||= BULK_SCOPE.test(fact) || /\bempty trash\b/i.test(fact);
  if ((DESTRUCTIVE.test(fact) && (HARD_OBJECT.test(fact) || HARD_DATA.test(fact) || HARD_ACCESS.test(fact))) || CLOSING.test(fact) && HARD_OBJECT.test(fact) || ACCESS.test(fact) && HARD_ACCESS.test(fact)) {
    return deny('destructive','Destructive account, access, project, workspace or data-loss operation is blocked');
  }
  if (bulk && (DESTRUCTIVE.test(fact) || /\bempty trash\b/i.test(fact) || ACCESS.test(fact) || CLOSING.test(fact) && !DISMISSAL.test(fact))) {
    return deny('bulk_destructive', 'Destructive operations on an observed bulk scope are blocked');
  }
  if (SEND.test(fact) && (bulk || BULK_SCOPE.test(fact) || pluralRecipients && PLURAL_RECIPIENTS.test(fact))) return deny('bulk_side_effect','Bulk external side effects are blocked');
  if (FINANCIAL_DESTRUCTION.test(fact) && FINANCIAL_OBJECT.test(fact) || /\bunsubscrib(?:e|es|ing)\b/.test(fact)) return deny('financial_destructive','Financially destructive cancellation, refund or void operation is blocked');
}
/** Recipient declarations are operation facts; audience/marketing counts are not. */
export function hasBulkRecipientDeclaration(text: string): boolean {
  const count = '(?:[2-9]\\d*|1\\d+|\\d{1,3}(?:,\\d{3})+)';
  const recipients = '(?:subscribers|recipients|members|users|contacts|customers)';
  return new RegExp(`\\b(?:(?:will be |to be )?(?:emailed|sent|delivered)|send|email|invite|notify)\\s+(?:to\\s+)?${count}\\s+${recipients}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:recipients|send to|email to)\\s*:\\s*${count}\\b`, 'i').test(text);
}

/** Owned future-tense confirmation is an operation; past-state filters are not. */
function prospectiveOperation(fact: string): string {
  return fact.replace(/\b(?:will be|about to be|to be)\s+(deleted|removed|erased|wiped|purged|destroyed|closed|deactivated|disabled|archived|revoked|cancelled|canceled|terminated|voided|refunded)\b/gi, (_match, verb: string) => ({ deleted:'delete', removed:'remove', erased:'erase', wiped:'wipe', purged:'purge', destroyed:'destroy', closed:'close', deactivated:'deactivate', disabled:'disable', archived:'archive', revoked:'revoke', cancelled:'cancel', canceled:'cancel', terminated:'terminate', voided:'void', refunded:'refund' })[verb.toLowerCase()] ?? verb);
}
function words(value: string): string { return value.normalize('NFKC').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_/-]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase(); }
function unique(values: Array<string|null|undefined>): string[] { return [...new Set(values.filter((value):value is string=>Boolean(value?.trim())).map(words))]; }
function pathWords(url: URL): string[] { return url.pathname.split('/').filter(Boolean).map(part => { try { return words(decodeURIComponent(part)); } catch { return words(part); } }); }
function urlPath(target: string, base: string): string { try { return pathWords(new URL(target,base)).join(' '); } catch { return ''; } }
/** Hostnames, ordinary resource paths and search/typed query values are not operations. */
function urlOperations(target: string|null|undefined, base: string): string[] {
  if (!target) return [];
  try {
    const url=new URL(target,base),segments=pathWords(url),facts:string[]=[];
    for (const [index,segment] of segments.entries()) {
      if (![DESTRUCTIVE,CLOSING,ACCESS,FINANCIAL_DESTRUCTION].some(pattern=>pattern.test(segment))) continue;
      const neighbours=index===0?segments.slice(1):segments.slice(0,index).reverse();
      // The nearest resource owns the operation: /projects/42/attachments/delete
      // deletes an attachment, not a project.
      const object=RESOURCE.test(segment)?'':neighbours.find(part=>RESOURCE.test(part))??neighbours.find(part=>!/^[0-9a-f-]{8,}$|^\d+$/.test(part))??'';
      facts.push(`${segment} ${object}`);
    }
    const operation=[...url.searchParams].filter(([key])=>/^(?:action|operation|op|command|cmd|method|do|task)$/i.test(key)).map(([,value])=>words(value));
    const objects=[...url.searchParams].filter(([key])=>/^(?:object|resource|scope)$/i.test(key)).map(([,value])=>words(value));
    for (const op of operation) facts.push(`${op} ${objects.join(' ')}`);
    return facts;
  } catch { return []; }
}
function external(target: string|null|undefined, base: string): boolean { try { return Boolean(target&&new URL(target,base).origin!==new URL(base).origin); } catch { return false; } }
function allow(category:string,reason:string):ActionSafetyDecision{return {verdict:'allow',category,reason,sideEffect:false};}
function log(category:string,reason:string,sideEffect:boolean):ActionSafetyDecision{return {verdict:'log',category,reason,sideEffect};}
function deny(category:string,reason:string):ActionSafetyDecision{return {verdict:'deny',category,reason,sideEffect:false};}
