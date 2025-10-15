import type { NextApiRequest, NextApiResponse } from 'next';

enum CourseType {
  '' = 'Tutti',
  L = 'Laurea',
  LM = 'Laurea magistrale',
  LMU = 'Laurea magistrale a ciclo unico',
  LS = 'Laurea specialistica',
  LSU = 'Laurea specialistica a ciclo unico',
}

export interface SearchResult {
  name: string;
  links: { name: string; url: string }[];
}

const SEARCH_URL =
  'https://offertaformativa.unipa.it/offweb/public/corso/ricercaSemplice.seam';

const generateOptions = (cookie: string, anno: number, viewState: string, formData: Record<string, string>) =>
  ({
    method: 'POST',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64; rv:102.0) Gecko/20100101 Firefox/102.0',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'it,en-US;q=0.7,en;q=0.3',
      'Accept-Encoding': 'gzip, deflate, br',
      Referer:
        'https://offertaformativa.unipa.it/offweb/public/corso/ricercaSemplice.seam',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://offertaformativa.unipa.it',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Cookie: cookie,
    },
    body: new URLSearchParams({
      ...formData,
      'frc:annoDecorate:anno': anno.toString(),
      'javax.faces.ViewState': viewState,
    }),
  } as RequestInit);

const extractFormData = ($: cheerio.Root): { viewState: string; formData: Record<string, string> } => {
  // Extract ViewState from the hidden input field
  const viewState = $('input[name="javax.faces.ViewState"]').val() as string || 'j_id1';
  
  // Extract the form and its fields
  const formData: Record<string, string> = {};
  const form = $('form[id="frc"]').first();
  
  if (form.length > 0) {
    // Find all hidden input fields in the form and copy them
    form.find('input[type="hidden"]').each((_, elem) => {
      const name = $(elem).attr('name');
      const value = $(elem).val() as string;
      if (name && name !== 'javax.faces.ViewState' && name !== 'frc:annoDecorate:anno') {
        formData[name] = value || '';
      }
    });
  }
  
  // Set the form identifier (always needed)
  formData['frc'] = 'frc';
  
  // Add the tipo corso field if not already present
  if (!Object.keys(formData).some(key => key.includes('tipoCorso') || key.includes('idTipoCorso'))) {
    formData['frc:tipoCorsoDecorate:idTipoCorso'] = '';
  }
  
  // Add the suggest corso field if not already present
  if (!Object.keys(formData).some(key => key.includes('suggestCorso'))) {
    formData['frc:suggestCorso'] = '';
  }
  
  return { viewState, formData };
};

const parseResponse = ($: cheerio.Root): SearchResult[] => {
  const results = [] as SearchResult[];
  const corsoElements = $('.corso');
  
  console.log('Found .corso elements:', corsoElements.length);
  if (corsoElements.length > 0) {
    console.log('First .corso children count:', corsoElements.first().children('* > a').length);
  }

  corsoElements.each((_, elem) => {
    const denominazione = $(elem).children('.denominazione').first();
    const name = denominazione.text().trim();
    
    if (!name) {
      // Skip entries without a name
      return;
    }
    
    const links = [] as { name: string; url: string }[];
    $(elem)
      .find('.sito > a, .sito > * > a')
      .each((_, link) => {
        const href = $(link).attr('href') || '';
        let match = href.match(/oidCurriculum=(\d{4,})/);
        const url = Array.isArray(match) && match.length > 1 ? match[1] : null;
        if (url === null) return;
        links.push({
          name: $(link).text().trim(),
          url,
        });
      });
    
    results.push({
      name,
      links,
    });
  });
  
  console.log('Parsed results:', results.length);
  return results;
};

const searchFromUnipa = async (req: NextApiRequest, res: NextApiResponse) => {
  const q = req.query;
  if (q.anno === undefined || q.anno instanceof Array) {
    res.status(400).json({ error: "Inserisci l'anno di ricerca" });
    return;
  }
  
  // Parse year from "xxxx/xxxx" format or single year
  let anno: number;
  const yearStr = q.anno.trim();
  
  // Check if it's in "xxxx/xxxx" format
  const yearMatch = yearStr.match(/^(\d{4})\/(\d{4})$/);
  if (yearMatch) {
    // Take the first year from the academic year format
    anno = parseInt(yearMatch[1]);
  } else if (/^\d{4}$/.test(yearStr)) {
    // It's a single year
    anno = parseInt(yearStr);
  } else {
    res.status(400).json({ error: "Anno non valido. Usa il formato YYYY o YYYY/YYYY (es. 2023 o 2023/2024)" });
    return;
  }
  
  // First, fetch the page to get cookies and extract form data
  const cookie_getter = await fetch(SEARCH_URL);
  const _cookie_header = cookie_getter.headers.get('set-cookie');
  if (_cookie_header === null || _cookie_header === undefined) {
    console.log('Nessun cookie, danno');
    res.status(500).json({ error: 'Qualcosa è andato storto' });
    return;
  }
  
  // Parse the initial page to extract ViewState and form structure
  const initialBody = await cookie_getter.text();
  const cheerio = await import('cheerio');
  const $initial = cheerio.load(initialBody);
  const { viewState, formData } = extractFormData($initial);
  
  console.log('ViewState extracted:', viewState);
  console.log('Form data extracted:', Object.keys(formData));
  
  // Now make the actual search request with extracted data
  const response = await fetch(
    SEARCH_URL,
    generateOptions(_cookie_header, anno, viewState, formData)
  );

  const body = await response.text();
  const $ = cheerio.load(body);
  
  // Debug: Log some info about the response
  console.log('Response status:', response.status);
  console.log('Response length:', body.length);
  console.log('Has #app:', $('#app').length > 0);
  console.log('Has .corso:', $('.corso').length);
  
  if (response.status !== 200) {
    console.error('Non-200 response from UNIPA');
    return res.status(500).json({ error: 'Qualcosa è andato storto' });
  }
  
  // Parse the results
  const results = parseResponse($);
  
  // return res.setHeader("Content-Type", "text/html").send(body)
  return res
    .status(200)
    .setHeader('Cache-Control', `max-age=0, s-maxage=${60 * 60 * 24 * 1}`)
    .json(results);
};

export const API_SEARCH_UNIPA_URL = '/api/unipa/search';

export default searchFromUnipa;
