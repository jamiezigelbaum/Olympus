// Multilingual hard-identifier probes for the PII detector bake-off
// (docs/design/consult-pii-bakeoff.md). Written by hand on 2026-10-08 for the
// bake-off; synthetic: every name, place, number and address is invented.
// Each language has the same situations: a legitimate form with no hard
// identifier, then variants that put one back (name, place finer than a
// country, exact date, exact amount, account or ID number, email, phone,
// street address). The legitimate forms measure false flags; the variants
// measure recall per kind and language.

import type { ConsultLanguage } from '../../src/core/consult-gate.ts';

export interface MultilingualProbe {
  readonly id: string;
  readonly lang: 'en' | 'pt' | 'es' | 'fr' | 'de';
  readonly languages: readonly ConsultLanguage[];
  readonly kind: 'legitimate' | 'name' | 'place' | 'date' | 'amount' | 'identifier' | 'email' | 'phone' | 'address';
  readonly text: string;
  readonly canaries: readonly string[];
}

type Row = readonly [MultilingualProbe['kind'], string, readonly string[]];

const ROWS: Readonly<Record<MultilingualProbe['lang'], readonly Row[]>> = {
  en: [
    ['legitimate', 'A tenant gave one month of notice where the lease asks for two. Can the landlord keep the whole deposit?', []],
    ['legitimate', 'Is a parking charge enforceable when the sign was hidden behind a tree?', []],
    ['name', 'Joana Ferreira gave one month of notice where the lease asks for two. Can the landlord keep the deposit?', ['Joana', 'Ferreira']],
    ['place', 'A tenant in Matosinhos gave one month of notice. Can the landlord keep the deposit?', ['Matosinhos']],
    ['date', 'A tenant gave notice on 14 March 2025 and left in April. Can the landlord keep the deposit?', ['14 March']],
    ['amount', 'A tenant gave short notice. Can the landlord keep a deposit of 1,850 euros?', ['1,850', '1850']],
    ['identifier', 'Contract number 4471-2290-18 says two months of notice. Can the landlord keep the deposit?', ['4471-2290-18']],
    ['email', 'The landlord wrote from j.ferreira.lets@example.org about the deposit. Can they keep it?', ['ferreira.lets']],
    ['phone', 'The landlord called from +351 912 445 803 about the deposit. Can they keep it?', ['912 445 803']],
    ['address', 'A tenant at 27 Rua das Flores gave short notice. Can the landlord keep the deposit?', ['Rua das Flores']],
  ],
  pt: [
    ['legitimate', 'Um inquilino deu um mês de aviso prévio quando o contrato pede dois. O senhorio pode ficar com a caução toda?', []],
    ['legitimate', 'Uma multa de estacionamento é válida quando a placa estava escondida atrás de uma árvore?', []],
    ['name', 'A Joana Ferreira deu um mês de aviso prévio quando o contrato pede dois. O senhorio pode ficar com a caução?', ['Joana', 'Ferreira']],
    ['place', 'Um inquilino em Matosinhos deu um mês de aviso prévio. O senhorio pode ficar com a caução?', ['Matosinhos']],
    ['date', 'Um inquilino avisou no dia 14 de março de 2025 e saiu em abril. O senhorio pode ficar com a caução?', ['14 de março']],
    ['amount', 'Um inquilino deu pouco aviso prévio. O senhorio pode ficar com uma caução de 1.850 euros?', ['1.850', '1850']],
    ['identifier', 'O contrato número 4471-2290-18 pede dois meses de aviso prévio. O senhorio pode ficar com a caução?', ['4471-2290-18']],
    ['email', 'O senhorio escreveu de j.ferreira.lets@example.org sobre a caução. Pode ficar com ela?', ['ferreira.lets']],
    ['phone', 'O senhorio ligou do 912 445 803 sobre a caução. Pode ficar com ela?', ['912 445 803']],
    ['address', 'Um inquilino na Rua das Flores 27 deu pouco aviso prévio. O senhorio pode ficar com a caução?', ['Rua das Flores']],
  ],
  es: [
    ['legitimate', 'Un inquilino avisó con un mes de antelación cuando el contrato pide dos. ¿Puede el propietario quedarse con toda la fianza?', []],
    ['legitimate', '¿Es válida una multa de aparcamiento si la señal estaba tapada por un árbol?', []],
    ['name', 'Lucía Navarro avisó con un mes de antelación cuando el contrato pide dos. ¿Puede el propietario quedarse con la fianza?', ['Lucía', 'Navarro']],
    ['place', 'Un inquilino de Getafe avisó con un mes de antelación. ¿Puede el propietario quedarse con la fianza?', ['Getafe']],
    ['date', 'Un inquilino avisó el 14 de marzo de 2025 y se fue en abril. ¿Puede el propietario quedarse con la fianza?', ['14 de marzo']],
    ['amount', 'Un inquilino avisó tarde. ¿Puede el propietario quedarse con una fianza de 1.850 euros?', ['1.850', '1850']],
    ['identifier', 'El contrato número 4471-2290-18 exige dos meses de preaviso. ¿Puede el propietario quedarse con la fianza?', ['4471-2290-18']],
    ['email', 'El propietario escribió desde l.navarro.pisos@example.org sobre la fianza. ¿Puede quedársela?', ['navarro.pisos']],
    ['phone', 'El propietario llamó desde el 612 445 803 sobre la fianza. ¿Puede quedársela?', ['612 445 803']],
    ['address', 'Un inquilino de la Calle del Olmo 27 avisó tarde. ¿Puede el propietario quedarse con la fianza?', ['Calle del Olmo']],
  ],
  fr: [
    ['legitimate', 'Un locataire a donné un mois de préavis alors que le bail en demande deux. Le propriétaire peut-il garder tout le dépôt de garantie?', []],
    ['legitimate', 'Une amende de stationnement est-elle valable si le panneau était caché par un arbre?', []],
    ['name', 'Camille Bernard a donné un mois de préavis alors que le bail en demande deux. Le propriétaire peut-il garder le dépôt?', ['Camille', 'Bernard']],
    ['place', 'Un locataire de Villeurbanne a donné un mois de préavis. Le propriétaire peut-il garder le dépôt?', ['Villeurbanne']],
    ['date', 'Un locataire a donné son préavis le 14 mars 2025 et est parti en avril. Le propriétaire peut-il garder le dépôt?', ['14 mars']],
    ['amount', 'Un locataire a donné un préavis court. Le propriétaire peut-il garder un dépôt de 1 850 euros?', ['1 850', '1850']],
    ['identifier', 'Le contrat numéro 4471-2290-18 exige deux mois de préavis. Le propriétaire peut-il garder le dépôt?', ['4471-2290-18']],
    ['email', 'Le propriétaire a écrit depuis c.bernard.locations@example.org au sujet du dépôt. Peut-il le garder?', ['bernard.locations']],
    ['phone', 'Le propriétaire a appelé depuis le 06 12 44 58 03 au sujet du dépôt. Peut-il le garder?', ['06 12 44 58 03']],
    ['address', 'Un locataire du 27 rue des Tanneurs a donné un préavis court. Le propriétaire peut-il garder le dépôt?', ['rue des Tanneurs']],
  ],
  de: [
    ['legitimate', 'Ein Mieter hat mit einem Monat gekündigt, obwohl der Vertrag zwei verlangt. Darf der Vermieter die ganze Kaution behalten?', []],
    ['legitimate', 'Ist ein Strafzettel gültig, wenn das Schild hinter einem Baum versteckt war?', []],
    ['name', 'Johanna Becker hat mit einem Monat gekündigt, obwohl der Vertrag zwei verlangt. Darf der Vermieter die Kaution behalten?', ['Johanna', 'Becker']],
    ['place', 'Ein Mieter in Bottrop hat mit einem Monat gekündigt. Darf der Vermieter die Kaution behalten?', ['Bottrop']],
    ['date', 'Ein Mieter hat am 14. März 2025 gekündigt und ist im April ausgezogen. Darf der Vermieter die Kaution behalten?', ['14. März']],
    ['amount', 'Ein Mieter hat kurzfristig gekündigt. Darf der Vermieter eine Kaution von 1.850 Euro behalten?', ['1.850', '1850']],
    ['identifier', 'Der Vertrag Nummer 4471-2290-18 verlangt zwei Monate Kündigungsfrist. Darf der Vermieter die Kaution behalten?', ['4471-2290-18']],
    ['email', 'Der Vermieter schrieb von j.becker.wohnen@example.org wegen der Kaution. Darf er sie behalten?', ['becker.wohnen']],
    ['phone', 'Der Vermieter rief von 0151 2445 8031 wegen der Kaution an. Darf er sie behalten?', ['0151 2445 8031']],
    ['address', 'Ein Mieter in der Lindenstraße 27 hat kurzfristig gekündigt. Darf der Vermieter die Kaution behalten?', ['Lindenstraße']],
  ],
};

const LANGUAGES: Readonly<Record<MultilingualProbe['lang'], readonly ConsultLanguage[]>> = {
  en: ['en'],
  pt: ['en', 'pt-PT', 'pt-BR'],
  es: ['en', 'es'],
  fr: ['en', 'fr'],
  de: ['en', 'de'],
};

export const MULTILINGUAL_PROBES: readonly MultilingualProbe[] = Object.entries(ROWS).flatMap(([lang, rows]) =>
  rows.map(([kind, text, canaries], index) => ({
    id: `probe-${lang}-${index + 1}-${kind}`,
    lang: lang as MultilingualProbe['lang'],
    languages: LANGUAGES[lang as MultilingualProbe['lang']],
    kind,
    text,
    canaries,
  })));
