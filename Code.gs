// ============================================================
// DAILY FOUNDER CALL BRIEFING — Google Apps Script v20
// ============================================================
// Single Claude call per meeting (parallel) → OpenAI fallback (parallel)
// Setup: Script Properties → ANTHROPIC_API_KEY, OPENAI_API_KEY
//        Trigger `main` daily 8–9 AM; run once manually to authorize
// ============================================================
 
var PROPS_, CONFIG_;
 
function getConfig_() {
  if (CONFIG_) return CONFIG_;
  CONFIG_ = {
    RECIPIENT_EMAIL: "zi@scopvc.com",
    INTERNAL_DOMAIN: "scopvc.com",
    KNOWN_INTERNALS: { "mtucker@scopvc.com": 1, "zi@scopvc.com": 1, "ziang.pan@scopvc.com": 1 },
    CLAUDE_MODEL: "claude-sonnet-4-6",
    OPENAI_MODEL: "gpt-4o-mini",
    PERSONAL_DOMAINS: {
      "gmail.com":1, "googlemail.com":1, "yahoo.com":1, "hotmail.com":1,
      "outlook.com":1, "aol.com":1, "icloud.com":1, "me.com":1, "mac.com":1,
      "live.com":1, "msn.com":1, "protonmail.com":1, "proton.me":1, "hey.com":1
    }
  };
  return CONFIG_;
}
 
function getProp_(key) {
  if (!PROPS_) PROPS_ = PropertiesService.getScriptProperties().getProperties();
  return PROPS_[key] || null;
}
 
function esc_(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
 
// Extract a displayable name from an email prefix: john.smith@ → John Smith
function nameFromEmail_(email) {
  var prefix = email.split("@")[0];
  var parts = prefix.split(/[._-]/);
  return parts.map(function(p) {
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }).join(" ");
}
 
// Parse full names from a calendar event title like "Alex Petrenko and Ziang Pan"
// Returns an array of name strings found in the title
function namesFromTitle_(title) {
  // Split on common separators: "and", "&", ",", "/"
  var parts = title.split(/\s+and\s+|\s*&\s*|\s*,\s*|\s*\/\s*/i);
  var names = [];
  for (var i = 0; i < parts.length; i++) {
    var trimmed = parts[i].trim();
    // A valid full name: 2+ words, each starting with uppercase, no weird chars
    if (/^[A-Z][a-zA-Z'-]+(\s+[A-Z][a-zA-Z'-]+)+$/.test(trimmed)) {
      names.push(trimmed);
    }
  }
  return names;
}
 
// Try to match a title name to a founder by checking if email prefix overlaps with name parts
function matchTitleName_(titleName, email) {
  var prefix = email.split("@")[0].toLowerCase();
  var nameParts = titleName.toLowerCase().split(/\s+/);
  // Match if email prefix contains first name, last name, or first initial + last name
  var first = nameParts[0], last = nameParts[nameParts.length - 1];
  return prefix.indexOf(first) >= 0 || prefix.indexOf(last) >= 0
    || prefix === (first.charAt(0) + last);
}
 
function fetchAllSafe_(requests) {
  if (requests.length === 0) return [];
  try { return UrlFetchApp.fetchAll(requests); } catch (e) {
    Logger.log("fetchAll failed (" + e + "), sequential fallback...");
    return requests.map(function(r) {
      try { return fetchWithRetry_(r.url, r); }
      catch (e2) { return { getResponseCode: function(){return 500;}, getContentText: function(){return "";} }; }
    });
  }
}
 
function fetchWithRetry_(url, options, maxRetries) {
  for (var attempt = 0, waitMs = 2000; attempt <= (maxRetries||3); attempt++) {
    var r = UrlFetchApp.fetch(url, options);
    if (r.getResponseCode() !== 429 || attempt === (maxRetries||3)) return r;
    Logger.log("429 — waiting " + (waitMs/1000) + "s...");
    Utilities.sleep(waitMs);
    waitMs = Math.min(waitMs * 2, 60000);
  }
}
 
function claudeReq_(apiKey, payload) {
  return {
    url: "https://api.anthropic.com/v1/messages", method: "post",
    contentType: "application/json", muteHttpExceptions: true,
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload)
  };
}
 
function parseClaudeToolUse_(resp, toolName) {
  if (resp.getResponseCode() !== 200) {
    Logger.log("Claude error " + resp.getResponseCode() + ": " + resp.getContentText().substring(0,300));
    return null;
  }
  try {
    var content = JSON.parse(resp.getContentText()).content;
    for (var i = 0; i < content.length; i++)
      if (content[i].type === "tool_use" && content[i].name === toolName) return content[i].input;
    return null;
  } catch(e) { Logger.log("Claude parse error: " + e); return null; }
}
 
// ======================== MAIN ========================
function main() {
  var today = new Date();
  if (today.getDay() === 0 || today.getDay() === 6) return;
 
  var calls = getFounderCalls(today);
  Logger.log(calls.length + " founder call(s) on " + today.toDateString());
  if (calls.length === 0) return;
 
  var briefings = batchClaudeResearch_(calls);
  batchOpenAIFallback_(briefings);
  sendBriefingEmail(today, briefings);
  Logger.log("Briefing sent.");
}
 
// ======================== CALENDAR ========================
function getFounderCalls(date) {
  var C = getConfig_(), cal = CalendarApp.getDefaultCalendar();
  var start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  var end = new Date(start.getTime() + 86400000 - 1);
  var events = cal.getEvents(start, end), calls = [], suffix = "@" + C.INTERNAL_DOMAIN;
 
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.isAllDayEvent() || ev.getMyStatus() === CalendarApp.GuestStatus.NO) continue;
    var guests = ev.getGuestList();
    if (!guests || !guests.length) continue;
 
    var ext = [], titleNames = namesFromTitle_(ev.getTitle());
    for (var j = 0; j < guests.length; j++) {
      var em = guests[j].getEmail().toLowerCase();
      if (em.endsWith(suffix) || C.KNOWN_INTERNALS[em]) continue;
 
      // Priority: 1) title name match, 2) calendar getName(), 3) email fallback
      var name = "";
      for (var tn = 0; tn < titleNames.length; tn++) {
        if (matchTitleName_(titleNames[tn], em)) { name = titleNames[tn]; break; }
      }
      if (!name) name = guests[j].getName();
      if (!name) name = nameFromEmail_(em);
 
      ext.push({ email: em, name: name });
    }
    if (ext.length)
      calls.push({ title: ev.getTitle(), startTime: ev.getStartTime(),
        timeStr: Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), "h:mm a"), founders: ext });
  }
  return calls.sort(function(a,b){ return a.startTime - b.startTime; });
}
 
// ======================== CLAUDE RESEARCH (1 CALL PER MEETING, PARALLEL) ========================
function batchClaudeResearch_(calls) {
  var C = getConfig_(), apiKey = getProp_("ANTHROPIC_API_KEY");
  var metas = [], reqs = [];
 
  for (var i = 0; i < calls.length; i++) {
    var call = calls[i], founders = call.founders;
    if (!founders.length) { metas.push({skip:true, i:i}); continue; }
 
    var domain = founders[0].email.split("@")[1];
    var personal = !!C.PERSONAL_DOMAINS[domain];
    var company = personal ? call.title : domain.replace(/\.\w+$/,"");
 
    metas.push({ skip:false, i:i, company:company, domain:domain });
 
    if (apiKey) {
      var founderList = "";
      for (var f = 0; f < founders.length; f++)
        founderList += "- " + founders[f].name + " (" + founders[f].email + ")\n";
 
      var prompt = "You are a research assistant for a VC investor preparing for founder calls.\n\n"
        + "MEETING: " + call.title + "\nCOMPANY: " + company + "\n"
        + (personal ? "" : "COMPANY DOMAIN: " + domain + "\n")
        + "\nDo these tasks IN ORDER:\n"
        + "\n1. COMPANY RESEARCH: Search and write a 3-4 sentence summary covering what they do, target market, stage, traction/funding. Be direct.\n"
        + "\n2. KEY TERMS: 3 terms specific to THIS company's product/technology/niche (not generic like TAM, ARR, SaaS).\n"
        + "\n3. COMPANY LINKEDIN: Find the company's linkedin.com/company/... page.\n"
        + "\n4. FOUNDER LINKEDIN: Now that you know the company, find LinkedIn profiles for:\n" + founderList
        + "   Search for each person on LinkedIn using their name + \"" + company + "\" to verify the match.\n"
        + "   Only return URLs you are confident are the right person at this company.\n"
        + "\nCall return_briefing with all findings. Use empty string for any LinkedIn URL you can't confirm.";
 
      reqs.push(claudeReq_(apiKey, {
        model: C.CLAUDE_MODEL, max_tokens: 2048,
        tool_choice: { type: "any" },
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 2 },
          { name: "return_briefing", description: "Return the complete briefing.",
            input_schema: { type: "object", required: ["company_summary","key_terms","company_linkedin_url","people"],
              properties: {
                company_summary: { type: "string" },
                key_terms: { type: "array", items: { type: "object", required: ["term","definition"],
                  properties: { term: {type:"string"}, definition: {type:"string"} }}},
                company_linkedin_url: { type: "string" },
                people: { type: "array", items: { type: "object", required: ["name","linkedin_url","confidence"],
                  properties: { name: {type:"string"}, linkedin_url: {type:"string"},
                    confidence: {type:"string", enum:["high","medium","low"]} }}}
              }
            }
          }
        ],
        messages: [{ role: "user", content: prompt }]
      }));
    }
  }
 
  var resps = apiKey ? fetchAllSafe_(reqs) : [];
  var briefings = [], ri = 0;
 
  for (var i = 0; i < metas.length; i++) {
    var m = metas[i], call = calls[m.i];
    if (m.skip) {
      briefings.push({ time:call.timeStr, title:call.title, companySummary:"No external attendees.",
        companyLinkedIn:"", keyTerms:[], founders:[], error:false });
      continue;
    }
 
    var cr = null;
    if (apiKey && ri < resps.length) { cr = parseClaudeToolUse_(resps[ri], "return_briefing"); ri++; }
 
    var summary = "", terms = [], compLI = "";
    if (cr) {
      summary = cr.company_summary || "";
      terms = cr.key_terms || [];
      compLI = cr.company_linkedin_url || "";
      var people = cr.people || [];
      for (var f = 0; f < call.founders.length; f++) {
        for (var p = 0; p < people.length; p++)
          if (people[p].name === call.founders[f].name && people[p].confidence !== "low" && people[p].linkedin_url)
            { call.founders[f].linkedIn = people[p].linkedin_url; break; }
      }
    }
 
    briefings.push({ time:call.timeStr, title:call.title, companySummary:summary,
      companyLinkedIn:compLI, keyTerms:terms, founders:call.founders,
      companyName:m.company, domain:m.domain, error:false });
  }
  return briefings;
}
 
// ======================== OPENAI FALLBACK (PARALLEL) ========================
function batchOpenAIFallback_(briefings) {
  var C = getConfig_(), apiKey = getProp_("OPENAI_API_KEY");
  if (!apiKey) return;
  var reqs = [], refs = [];
 
  for (var i = 0; i < briefings.length; i++) {
    var b = briefings[i];
    if (b.error) continue;
    var ns = (b.companySummary||"").length < 50, nt = !b.keyTerms || !b.keyTerms.length;
    if (!ns && !nt) continue;
 
    var name = b.companyName || b.title, dom = b.domain || "";
    var parts = ['You are a research assistant for a VC investor.\nCompany: ' + name + ' (' + dom + ')\nReturn STRICT JSON only.\n'];
    if (ns) parts.push('"summary": 3-4 sentence company summary (what they do, market, stage, traction). Direct.');
    if (nt) parts.push('"terms": array of 3 {term, definition} objects specific to THIS company (not TAM/ARR/SaaS).');
    parts.push('Example: {' + (ns?'"summary":"..."':'') + (ns&&nt?',':'') + (nt?'"terms":[{"term":"X","definition":"..."}]':'') + '}');
 
    reqs.push({ url: "https://api.openai.com/v1/chat/completions", method: "post",
      contentType: "application/json", headers: {"Authorization":"Bearer "+apiKey}, muteHttpExceptions: true,
      payload: JSON.stringify({ model: C.OPENAI_MODEL, max_tokens: 500, messages: [{role:"user", content: parts.join("\n")}] }) });
    refs.push({idx:i, ns:ns, nt:nt});
  }
 
  var resps = fetchAllSafe_(reqs);
  for (var r = 0; r < resps.length; r++) {
    if (!resps[r] || resps[r].getResponseCode() !== 200) continue;
    try {
      var text = JSON.parse(resps[r].getContentText()).choices[0].message.content.trim();
      var parsed = JSON.parse(text.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim());
      if (refs[r].ns && parsed.summary) briefings[refs[r].idx].companySummary = parsed.summary;
      if (refs[r].nt && parsed.terms) briefings[refs[r].idx].keyTerms = parsed.terms;
    } catch(e) { Logger.log("OpenAI parse error: " + e); }
  }
}
 
// ======================== EMAIL ========================
function sendBriefingEmail(date, briefings) {
  var C = getConfig_(), tz = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(date, tz, "MMMM d, yyyy");
  var S = { wrap: 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a',
    h1: 'font-size:22px;font-weight:600;border-bottom:2px solid #2563eb;padding-bottom:8px;margin-bottom:24px',
    h2: 'font-size:18px;color:#2563eb;margin:0 0 12px 0',
    h3: 'font-size:13px;text-transform:uppercase;color:#6b7280;margin:0 0 4px 0',
    link: 'color:#2563eb;text-decoration:none', hr: 'border:none;border-top:1px solid #e5e7eb;margin:24px 0' };
 
  var h = '<div style="' + S.wrap + '"><h1 style="' + S.h1 + '">Founder Call Briefing — ' + dateStr + '</h1>';
 
  for (var i = 0; i < briefings.length; i++) {
    var b = briefings[i], t = esc_(b.time), n = esc_(b.title);
    if (b.error) {
      h += '<div style="margin-bottom:32px;padding:16px;background:#fef2f2;border-left:4px solid #ef4444">'
        + '<h2 style="font-size:18px;margin:0">' + t + ' — ' + n + '</h2>'
        + '<p style="color:#991b1b;margin:8px 0 0 0">Error: ' + esc_(b.errorMsg) + '</p></div>';
      continue;
    }
 
    h += '<div style="margin-bottom:32px"><h2 style="' + S.h2 + '">' + t + ' — ' + n + '</h2>';
 
    h += '<div style="margin-bottom:12px"><h3 style="' + S.h3 + '">Company</h3>'
      + '<p style="margin:0;line-height:1.5">' + esc_(b.companySummary || "No summary available.") + '</p>';
    if (b.companyLinkedIn)
      h += '<p style="margin:6px 0 0 0"><a href="' + esc_(b.companyLinkedIn) + '" style="' + S.link + ';font-size:13px">&#x1F3E2; Company LinkedIn</a></p>';
    h += '</div>';
 
    h += '<div style="margin-bottom:12px"><h3 style="' + S.h3 + '">Founders</h3>';
    for (var j = 0; j < (b.founders||[]).length; j++) {
      var f = b.founders[j], sn = esc_(f.name);
      h += '<p style="margin:4px 0"><strong>' + sn + '</strong> ';
      if (f.linkedIn) {
        h += '<a href="' + esc_(f.linkedIn) + '" style="' + S.link + '">LinkedIn</a>';
      } else {
        var searchTerms = f.name + (b.companyName ? ' ' + b.companyName : '');
        h += '<a href="https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(searchTerms)
          + '" style="color:#9ca3af;text-decoration:none">Search LinkedIn</a>';
      }
      h += '</p>';
    }
    h += '</div>';
 
    h += '<div style="margin-bottom:12px"><h3 style="' + S.h3 + '">Key Terms</h3>';
    for (var k = 0; k < (b.keyTerms||[]).length; k++)
      h += '<p style="margin:4px 0"><strong>' + (k+1) + '. ' + esc_(b.keyTerms[k].term)
        + '</strong> — ' + esc_(b.keyTerms[k].definition) + '</p>';
    h += '</div><hr style="' + S.hr + '"></div>';
  }
 
  h += '<p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:32px">Generated by ScOp Daily Briefing</p></div>';
  GmailApp.sendEmail(C.RECIPIENT_EMAIL, "Founder Call Briefing — " + dateStr, "View in HTML.", { htmlBody: h });
}
