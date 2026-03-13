// ============================================================
// DAILY FOUNDER CALL BRIEFING — Google Apps Script v8
// ============================================================
// Company research:  Website scrape → Claude → OpenAI fallback
// Founder bios:      Claude → OpenAI fallback
// LinkedIn:          Claude → OpenAI fallback → N/A
// ============================================================
// SETUP:
//   1. Script Properties (Project Settings → Script Properties):
//      - ANTHROPIC_API_KEY  (required)
//      - OPENAI_API_KEY     (required for fallback)
//
//   2. Set a time-driven trigger on `main` (daily, 8–9 AM)
//   3. Run `main` once manually to authorize Calendar + Gmail
// ============================================================
 
// --------------- CONFIGURATION ---------------
 
var CONFIG = {
  RECIPIENT_EMAIL: "zi@scopvc.com",
  INTERNAL_DOMAIN: "scopvc.com",
  KNOWN_INTERNALS: ["mtucker@scopvc.com", "zi@scopvc.com", "ziang.pan@scopvc.com"],
  SEND_IF_NO_CALLS: false,
  CLAUDE_MODEL: "claude-sonnet-4-6",
  OPENAI_MODEL: "gpt-4o-mini",
  PERSONAL_DOMAINS: [
    "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com",
    "outlook.com", "aol.com", "icloud.com", "me.com", "mac.com",
    "live.com", "msn.com", "protonmail.com", "proton.me", "hey.com"
  ]
};
 
// --------------- MAIN ---------------
 
function main() {
  var today = new Date();
  var day = today.getDay();
  if (day === 0 || day === 6) {
    Logger.log("Weekend — skipping.");
    return;
  }
 
  Logger.log("Starting daily briefing for " + today.toDateString());
 
  var founderCalls = getFounderCalls(today);
  Logger.log("Found " + founderCalls.length + " founder call(s).");
 
  if (founderCalls.length === 0) {
    if (CONFIG.SEND_IF_NO_CALLS) {
      sendNoCalls(today);
    } else {
      Logger.log("No founder calls today. Skipping email.");
    }
    return;
  }
 
  var briefings = [];
  for (var i = 0; i < founderCalls.length; i++) {
    try {
      var briefing = buildBriefing(founderCalls[i]);
      briefings.push(briefing);
    } catch (err) {
      Logger.log("Error for " + founderCalls[i].title + ": " + err);
      briefings.push({
        time: founderCalls[i].timeStr,
        title: founderCalls[i].title,
        error: true,
        errorMsg: err.toString()
      });
    }
  }
 
  sendBriefingEmail(today, briefings);
  Logger.log("Briefing email sent.");
}
 
// --------------- CALENDAR PARSING ---------------
 
function getFounderCalls(date) {
  var calendar = CalendarApp.getDefaultCalendar();
  var startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
  var endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
  var events = calendar.getEvents(startOfDay, endOfDay);
  var founderCalls = [];
 
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (event.isAllDayEvent()) continue;
    var myStatus = event.getMyStatus();
    if (myStatus === CalendarApp.GuestStatus.NO) continue;
 
    var attendees = event.getGuestList();
    if (attendees.length === 0) continue;
 
    var externalAttendees = [];
    for (var j = 0; j < attendees.length; j++) {
      var email = attendees[j].getEmail().toLowerCase();
      if (email.endsWith("@" + CONFIG.INTERNAL_DOMAIN)) continue;
      if (CONFIG.KNOWN_INTERNALS.indexOf(email) !== -1) continue;
      externalAttendees.push({
        email: email,
        name: attendees[j].getName() || email.split("@")[0]
      });
    }
 
    if (externalAttendees.length === 0) continue;
 
    var startTime = event.getStartTime();
    var timeStr = Utilities.formatDate(startTime, Session.getScriptTimeZone(), "h:mm a");
    founderCalls.push({
      title: event.getTitle(),
      startTime: startTime,
      timeStr: timeStr,
      founders: externalAttendees
    });
  }
 
  founderCalls.sort(function(a, b) { return a.startTime - b.startTime; });
  return founderCalls;
}
 
// --------------- RESEARCH + BRIEFING ---------------
// Company:  1. Scrape website
//           2. Claude synthesizes → company_summary, founder_bios, key_terms
//           3. OpenAI fills in anything Claude returned as N/A or empty
//
// Founders: 1. Claude bio (from step 2 above)
//           2. OpenAI bio fallback
//           3. If still no bio → Claude LinkedIn → OpenAI LinkedIn → N/A
 
function buildBriefing(call) {
  var founders = call.founders;
  var primaryEmail = founders[0].email;
  var domain = primaryEmail.split("@")[1];
  var isPersonalDomain = CONFIG.PERSONAL_DOMAINS.indexOf(domain) !== -1;
  var companyName = isPersonalDomain
    ? call.title
    : domain.replace(/\.\w+$/, "");
  var founderNames = founders.map(function(f) { return f.name; }).join(", ");
 
  // --- STAGE 1: Scrape company website ---
  var websiteContent = "";
  if (!isPersonalDomain) {
    var homepage = fetchWebsiteText("https://" + domain);
    if (homepage) {
      websiteContent += "=== HOMEPAGE (" + domain + ") ===\n" + homepage + "\n\n";
    }
    var subpages = ["/about", "/about-us", "/team", "/company", "/products", "/solutions"];
    for (var i = 0; i < subpages.length; i++) {
      var sub = fetchWebsiteText("https://" + domain + subpages[i]);
      if (sub && sub.length > 100) {
        websiteContent += "=== " + domain + subpages[i] + " ===\n" + sub + "\n\n";
        break;
      }
    }
  }
 
  // --- STAGE 2: Claude generates full briefing ---
  var claudeResult = callClaude(call.title, companyName, domain, founderNames, websiteContent);
 
  // --- STAGE 3: OpenAI fills in weak company summary or missing key terms ---
  var companySummary = claudeResult.company_summary || "";
  if (companySummary.length < 50) {
    Logger.log("Claude company summary thin — trying OpenAI.");
    var openAiSummary = getOpenAICompanySummary(companyName, domain, websiteContent);
    if (openAiSummary) companySummary = openAiSummary;
  }
 
  var keyTerms = claudeResult.key_terms || [];
  if (keyTerms.length === 0) {
    Logger.log("Claude returned no key terms — trying OpenAI.");
    var openAiTerms = getOpenAIKeyTerms(companyName, domain);
    if (openAiTerms) keyTerms = openAiTerms;
  }
 
  // --- STAGE 4: Build founder info with Claude → OpenAI → LinkedIn fallbacks ---
  var claudeBios = claudeResult.founder_bios || [];
  var founderInfo = [];
 
  for (var j = 0; j < founders.length; j++) {
    var f = founders[j];
 
    // Check Claude bio
    var claudeBio = null;
    for (var k = 0; k < claudeBios.length; k++) {
      if (claudeBios[k].name && f.name &&
          claudeBios[k].name.toLowerCase().indexOf(f.name.toLowerCase().split(" ")[0]) !== -1) {
        claudeBio = claudeBios[k];
        break;
      }
    }
    var bio = (claudeBio && claudeBio.bio && claudeBio.bio !== "N/A" && claudeBio.bio.length > 5)
      ? claudeBio.bio
      : null;
 
    // OpenAI bio fallback
    if (!bio) {
      Logger.log("No Claude bio for " + f.name + " — trying OpenAI.");
      bio = getOpenAIFounderBio(f.name, companyName);
    }
 
    // LinkedIn fallback (only if no bio found from either)
    var linkedInUrl = null;
    if (!bio) {
      Logger.log("No bio for " + f.name + " — trying LinkedIn lookup.");
      linkedInUrl = findLinkedInProfile(f.name, companyName);
    }
 
    founderInfo.push({
      name: f.name,
      email: f.email,
      bio: bio,
      linkedIn: linkedInUrl
    });
  }
 
  return {
    time: call.timeStr,
    title: call.title,
    companySummary: companySummary,
    keyTerms: keyTerms,
    founders: founderInfo,
    error: false
  };
}
 
// --------------- LINKEDIN PROFILE FINDER ---------------
// Claude first, OpenAI second, N/A if neither knows
 
function findLinkedInProfile(personName, companyName) {
  var url = findLinkedInViaClaude(personName, companyName);
  if (url) {
    Logger.log("Claude found LinkedIn for " + personName + ": " + url);
    return url;
  }
 
  Logger.log("Claude had no LinkedIn for " + personName + " — trying OpenAI.");
  url = findLinkedInViaOpenAI(personName, companyName);
  if (url) {
    Logger.log("OpenAI found LinkedIn for " + personName + ": " + url);
    return url;
  }
 
  return null;
}
 
function findLinkedInViaClaude(personName, companyName) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
 
  var prompt = 'Return the LinkedIn profile URL for this person.\n\n'
    + 'Name: ' + personName + '\n'
    + 'Company: ' + companyName + '\n\n'
    + 'Rules:\n'
    + '- Return ONLY the URL in this format: https://www.linkedin.com/in/username\n'
    + '- If you are not confident, return exactly: N/A\n'
    + '- Do not fabricate a URL.';
 
  var payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }]
  };
 
  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
 
  try {
    var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", options);
    if (response.getResponseCode() !== 200) return null;
    var result = JSON.parse(response.getContentText());
    var url = result.content[0].text.trim();
    return url.indexOf("linkedin.com/in/") !== -1 ? url : null;
  } catch (err) {
    Logger.log("Claude LinkedIn lookup failed: " + err);
    return null;
  }
}
 
function findLinkedInViaOpenAI(personName, companyName) {
  var prompt = 'Return the LinkedIn profile URL for this person.\n\n'
    + 'Name: ' + personName + '\n'
    + 'Company: ' + companyName + '\n\n'
    + 'Rules:\n'
    + '- Return ONLY the URL in this format: https://www.linkedin.com/in/username\n'
    + '- If you are not confident, return exactly: N/A\n'
    + '- Do not fabricate a URL.';
 
  var result = callOpenAI(prompt, 100);
  if (!result) return null;
  var match = result.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s\)\"\']+/);
  return match ? match[0] : null;
}
 
// --------------- OPENAI FALLBACK FUNCTIONS ---------------
 
function getOpenAICompanySummary(companyName, domain, websiteContent) {
  var prompt = 'You are a research assistant for a VC investor.\n\n'
    + 'Write a 3-4 sentence company summary for ' + companyName + ' (' + domain + ').\n\n';
 
  if (websiteContent && websiteContent.trim().length > 50) {
    prompt += 'Website content:\n' + websiteContent + '\n\n';
  }
 
  prompt += 'Cover: what the company does, target market/industry, stage, and any notable traction or funding.\n'
    + 'Be direct. No hedging phrases like "based on available information" or "it appears".';
 
  return callOpenAI(prompt, 300);
}
 
function getOpenAIKeyTerms(companyName, domain) {
  var prompt = 'You are a research assistant for a VC investor.\n\n'
    + 'Return 3 industry-specific or technical terms related to ' + companyName + ' (' + domain + ') '
    + 'that a generalist VC investor might not know. Do NOT use generic terms like TAM, ARR, or SaaS.\n\n'
    + 'Return STRICT JSON only — no markdown, no extra text:\n'
    + '[\n'
    + '  { "term": "Term", "definition": "1-2 sentence definition." },\n'
    + '  { "term": "Term", "definition": "1-2 sentence definition." },\n'
    + '  { "term": "Term", "definition": "1-2 sentence definition." }\n'
    + ']';
 
  var result = callOpenAI(prompt, 400);
  if (!result) return null;
 
  try {
    var cleaned = result.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    var parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    Logger.log("OpenAI key terms JSON parse failed: " + result);
    return null;
  }
}
 
function getOpenAIFounderBio(founderName, companyName) {
  var prompt = 'Write a brief professional bio for ' + founderName + ', associated with ' + companyName + '.\n\n'
    + 'Include education (degree + school) and career highlights from the last 10 years (Role, Company, Years).\n'
    + 'If you have no reliable information about this person, respond with exactly: N/A\n'
    + 'Do not fabricate. Do not hedge. Be direct and factual.';
 
  var result = callOpenAI(prompt, 300);
  if (!result || result.trim() === "N/A" || result.trim().length < 10) return null;
  return result.trim();
}
 
// --------------- OPENAI BASE CALLER ---------------
 
function callOpenAI(prompt, maxTokens) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY");
  if (!apiKey) {
    Logger.log("OPENAI_API_KEY not set — skipping OpenAI call.");
    return null;
  }
 
  var payload = {
    model: CONFIG.OPENAI_MODEL,
    max_tokens: maxTokens || 300,
    messages: [{ role: "user", content: prompt }]
  };
 
  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": "Bearer " + apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
 
  try {
    var response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
    if (response.getResponseCode() !== 200) {
      Logger.log("OpenAI error (" + response.getResponseCode() + "): " + response.getContentText().substring(0, 500));
      return null;
    }
    var result = JSON.parse(response.getContentText());
    return result.choices[0].message.content.trim();
  } catch (err) {
    Logger.log("OpenAI call failed: " + err);
    return null;
  }
}
 
// --------------- WEB FETCHER ---------------
 
function fetchWebsiteText(url) {
  try {
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (response.getResponseCode() !== 200) return null;
 
    var html = response.getContentText();
 
    // Extract meta tags first (work even on JS-heavy sites)
    var meta = "";
    var m1 = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (m1) meta += m1[1] + "\n";
    var m2 = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (m2) meta += m2[1] + "\n";
    var m3 = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m3) meta += m3[1] + "\n";
 
    // Strip non-content elements
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
    html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
    html = html.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
    html = html.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
    html = html.replace(/<header[\s\S]*?<\/header>/gi, " ");
    html = html.replace(/<[^>]+>/g, " ");
    html = html.replace(/&nbsp;/g, " ");
    html = html.replace(/\s+/g, " ").trim();
 
    var combined = meta + html;
    if (combined.trim().length < 100) {
      return meta.length > 10 ? meta : null;
    }
    return combined.substring(0, 4000);
  } catch (err) {
    Logger.log("Fetch failed: " + url + " — " + err);
    return null;
  }
}
 
// --------------- CLAUDE API ---------------
 
function callClaude(meetingTitle, companyName, domain, founderNames, websiteContent) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not found in Script Properties.");
  }
 
  var hasWebsite = websiteContent && websiteContent.trim().length > 50;
 
  var prompt = 'You are a research assistant for a VC investor preparing for founder calls.\n\n'
    + 'MEETING: ' + meetingTitle + '\n'
    + 'COMPANY NAME: ' + companyName + '\n'
    + 'COMPANY DOMAIN: ' + domain + '\n'
    + 'FOUNDERS: ' + founderNames + '\n\n';
 
  if (hasWebsite) {
    prompt += 'WEBSITE CONTENT (scraped from ' + domain + '):\n' + websiteContent + '\n\n';
  }
 
  prompt += 'INSTRUCTIONS:\n'
    + 'Use the website content as your PRIMARY source, then your own knowledge.\n\n'
    + (hasWebsite ? '' : 'No website content was available. Rely on your own knowledge.\n\n')
    + 'Return STRICT JSON only — no markdown, no code fences, no extra text:\n'
    + '{\n'
    + '  "company_summary": "3-4 sentences: what the company does, target market/industry, stage, and any notable traction or funding.",\n'
    + '  "founder_bios": [\n'
    + '    { "name": "Full Name", "bio": "Education + career highlights (last 10 yrs). If unknown, write exactly: N/A" }\n'
    + '  ],\n'
    + '  "key_terms": [\n'
    + '    { "term": "Term", "definition": "1-2 sentence definition." },\n'
    + '    { "term": "Term", "definition": "1-2 sentence definition." },\n'
    + '    { "term": "Term", "definition": "1-2 sentence definition." }\n'
    + '  ]\n'
    + '}\n\n'
    + 'RULES:\n'
    + '- Do NOT include Zi Pan or Ziang Pan in founder_bios.\n'
    + '- company_summary: be direct — no hedging, no "based on available information" phrasing.\n'
    + '- founder_bios: include education (degree, school) and recent career (Role, Company, Years). If truly unknown, write exactly "N/A".\n'
    + '- key_terms: 3 terms specific to this company\'s industry or technical space. NOT generic terms like "TAM", "ARR", "SaaS".\n'
    + '- Return ONLY the JSON object.';
 
  var payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }]
  };
 
  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
 
  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", options);
  if (response.getResponseCode() !== 200) {
    Logger.log("Claude error (" + response.getResponseCode() + "): " + response.getContentText());
    throw new Error("Claude API returned " + response.getResponseCode());
  }
 
  var result = JSON.parse(response.getContentText());
  var text = result.content[0].text;
 
  try {
    var cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    Logger.log("Claude JSON parse failed: " + text);
    throw new Error("Claude returned invalid JSON.");
  }
}
 
// --------------- EMAIL COMPOSER ---------------
 
function sendBriefingEmail(date, briefings) {
  var dateStr = Utilities.formatDate(date, Session.getScriptTimeZone(), "MMMM d, yyyy");
  var subject = "Founder Call Briefing — " + dateStr;
 
  var html = '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">'
    + '<h1 style="font-size: 22px; font-weight: 600; border-bottom: 2px solid #2563eb; padding-bottom: 8px; margin-bottom: 24px;">'
    + 'Founder Call Briefing — ' + dateStr + '</h1>';
 
  for (var i = 0; i < briefings.length; i++) {
    var b = briefings[i];
 
    if (b.error) {
      html += '<div style="margin-bottom: 32px; padding: 16px; background: #fef2f2; border-left: 4px solid #ef4444;">'
        + '<h2 style="font-size: 18px; margin: 0;">' + b.time + ' — ' + b.title + '</h2>'
        + '<p style="color: #991b1b; margin: 8px 0 0 0;">Could not generate briefing: ' + b.errorMsg + '</p></div>';
      continue;
    }
 
    // Founders — bio if available, LinkedIn link if no bio, N/A if neither
    var foundersHtml = "";
    for (var j = 0; j < b.founders.length; j++) {
      var f = b.founders[j];
      if (f.bio) {
        var linkedInSuffix = f.linkedIn
          ? ' (<a href="' + f.linkedIn + '" style="color: #2563eb;">LinkedIn</a>)'
          : '';
        foundersHtml += '<p style="margin: 4px 0;"><strong>' + f.name + ':</strong> '
          + f.bio + linkedInSuffix + '</p>';
      } else if (f.linkedIn) {
        foundersHtml += '<p style="margin: 4px 0;"><strong>' + f.name + '</strong> '
          + '(<a href="' + f.linkedIn + '" style="color: #2563eb;">LinkedIn</a>)</p>';
      } else {
        foundersHtml += '<p style="margin: 4px 0;"><strong>' + f.name + '</strong> — N/A</p>';
      }
    }
 
    // Key terms
    var termsHtml = "";
    if (b.keyTerms && b.keyTerms.length > 0) {
      for (var k = 0; k < b.keyTerms.length; k++) {
        var kt = b.keyTerms[k];
        termsHtml += '<p style="margin: 4px 0;"><strong>' + (k + 1) + '. ' + kt.term + '</strong> — ' + kt.definition + '</p>';
      }
    }
 
    html += '<div style="margin-bottom: 32px;">'
      + '<h2 style="font-size: 18px; color: #2563eb; margin: 0 0 12px 0;">' + b.time + ' — ' + b.title + '</h2>'
      + '<div style="margin-bottom: 12px;">'
      + '<h3 style="font-size: 13px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px 0;">Company</h3>'
      + '<p style="margin: 0; line-height: 1.5;">' + b.companySummary + '</p>'
      + '</div>'
      + '<div style="margin-bottom: 12px;">'
      + '<h3 style="font-size: 13px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px 0;">Founders</h3>'
      + foundersHtml
      + '</div>'
      + '<div style="margin-bottom: 12px;">'
      + '<h3 style="font-size: 13px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px 0;">Key Terms</h3>'
      + termsHtml
      + '</div>'
      + '<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">'
      + '</div>';
  }
 
  html += '<p style="font-size: 12px; color: #9ca3af; text-align: center; margin-top: 32px;">'
    + 'Generated by ScOp Daily Briefing</p></div>';
 
  GmailApp.sendEmail(CONFIG.RECIPIENT_EMAIL, subject, "View this email in HTML.", {
    htmlBody: html
  });
}
 
function sendNoCalls(date) {
  var dateStr = Utilities.formatDate(date, Session.getScriptTimeZone(), "MMMM d, yyyy");
  GmailApp.sendEmail(CONFIG.RECIPIENT_EMAIL, "Founder Call Briefing — " + dateStr, "No founder calls on your calendar today.");
}
