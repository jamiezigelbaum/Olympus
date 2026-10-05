// Fixed sample of personal names, places and brands across cultures, for
// measuring how many the vocabulary packs admit (round-3 review). Written by
// hand on 2026-10-05 before the round-3 builder changes were measured; not
// drawn from any of the packs' sources. Fold to ASCII lower case before use.

export const SAMPLE_GIVEN_NAMES: readonly string[] = [
  // English and Celtic
  'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara',
  'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Grace', 'Rose', 'Will', 'Mark', 'Bill',
  'Hope', 'Faith', 'Ivy', 'Hazel', 'Robin', 'Siobhan', 'Niamh', 'Aoife', 'Ciaran', 'Eilidh', 'Rhys', 'Gareth', 'Bronwen',
  // French, Spanish, Portuguese, Italian
  'Jean', 'Pierre', 'Camille', 'Margaux', 'Thibault', 'Mathilde', 'Lucie', 'Antoine', 'Juan', 'Carmen', 'Pilar', 'Javier',
  'Lucia', 'Alejandro', 'Dolores', 'Consuelo', 'Joao', 'Ana', 'Rosa', 'Guilherme', 'Beatriz', 'Goncalo', 'Ines', 'Rui',
  'Giulia', 'Matteo', 'Chiara', 'Lorenzo', 'Francesca', 'Giovanni', 'Alessandro', 'Serena',
  // German, Dutch, Nordic
  'Hans', 'Greta', 'Lukas', 'Johanna', 'Matthias', 'Anke', 'Jan', 'Sanne', 'Bram', 'Femke', 'Pieter', 'Lotte', 'Sven', 'Ingrid',
  'Astrid', 'Lars', 'Freya', 'Bjorn', 'Sigrid', 'Elin',
  // Slavic and Baltic
  'Ivan', 'Olga', 'Dmitri', 'Natasha', 'Katarzyna', 'Piotr', 'Agnieszka', 'Milos', 'Jelena', 'Tomas', 'Ruta', 'Vesna',
  // Arabic, Persian, Turkish
  'Mohammed', 'Fatima', 'Ahmed', 'Aisha', 'Omar', 'Layla', 'Yusuf', 'Noor', 'Hassan', 'Zainab', 'Reza', 'Shirin', 'Dariush',
  'Emre', 'Elif', 'Mehmet', 'Ayse',
  // South Asian
  'Anil', 'Priya', 'Rahul', 'Ananya', 'Vikram', 'Deepa', 'Arjun', 'Lakshmi', 'Sanjay', 'Kavya', 'Imran', 'Sadia',
  // East and Southeast Asian
  'Wei', 'Mei', 'Jun', 'Ling', 'Hiroshi', 'Yuki', 'Haruto', 'Sakura', 'Minjun', 'Jiwoo', 'Seo', 'Linh', 'Minh', 'Thanh',
  'Somchai', 'Nok', 'Ayu', 'Budi', 'Siti', 'Rizal',
  // African
  'Chinedu', 'Ngozi', 'Kwame', 'Ama', 'Abebe', 'Tigist', 'Thabo', 'Naledi', 'Amara', 'Kofi', 'Zola', 'Juma', 'Wanjiru',
  'Oluwaseun', 'Chiamaka', 'Sipho',
  // Latin American and other
  'Ximena', 'Mateo', 'Valentina', 'Santiago', 'Camila', 'Joaquin', 'Renata', 'Thiago', 'Paloma', 'Tupac',
  'Kalani', 'Leilani', 'Moana', 'Tane', 'Aroha', 'Kai', 'Nia', 'Zara', 'Leo', 'Max', 'Eva', 'Ada', 'Iris', 'Dawn', 'Jade',
  'Jasper', 'Felix', 'Hugo', 'Oscar', 'Otto', 'Mason', 'Hunter', 'Archer', 'Taylor', 'Jordan', 'Morgan', 'Casey', 'Riley',
  'Avery', 'Quinn', 'Sage', 'River', 'Sky', 'Summer', 'Autumn', 'April', 'June', 'August', 'Victoria', 'Paris', 'Florence',
  'Sydney', 'Chelsea', 'Brooklyn', 'Dakota', 'Savannah',
];

export const SAMPLE_SURNAMES: readonly string[] = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Taylor', 'Clark', 'Walker', 'Baker',
  'Carter', 'Cooper', 'Fisher', 'Mason', 'Turner', 'Wood', 'Stone', 'Bell', 'Hill', 'Moore', 'Young', 'King', 'Wright',
  'Green', 'Black', 'White', 'Fenwick', 'Okafor', 'Achterberg', 'Brandtner', 'Holt', 'Marsh', 'Fox', 'Lamb', 'Swan', 'Crane',
  'Martin', 'Bernard', 'Dubois', 'Durand', 'Lefebvre', 'Moreau', 'Garnier', 'Fournier', 'Girard', 'Bonnet', 'Rousseau', 'Leroy',
  'Garcia', 'Martinez', 'Lopez', 'Gonzalez', 'Rodriguez', 'Fernandez', 'Sanchez', 'Perez', 'Romero', 'Navarro', 'Torres',
  'Ramos', 'Silva', 'Santos', 'Ferreira', 'Pereira', 'Oliveira', 'Costa', 'Rodrigues', 'Almeida', 'Carvalho', 'Sousa',
  'Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco', 'Bruno', 'Gallo',
  'Muller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Richter',
  'Jansen', 'Visser', 'Bakker', 'Smit', 'Meijer', 'Mulder', 'Bos', 'Vos', 'Peters', 'Hendriks', 'Dekker', 'Brouwer',
  'Johansson', 'Andersson', 'Nilsson', 'Larsen', 'Hansen', 'Nielsen', 'Lund', 'Berg', 'Dahl', 'Strand',
  'Ivanov', 'Petrov', 'Smirnov', 'Kowalski', 'Nowak', 'Wisniewski', 'Novak', 'Horvat', 'Kovac', 'Popescu', 'Nagy',
  'Yilmaz', 'Kaya', 'Demir', 'Sahin', 'Celik', 'Haddad', 'Khalil', 'Nasser', 'Rahman', 'Hosseini', 'Karimi', 'Tehrani',
  'Patel', 'Sharma', 'Singh', 'Kumar', 'Gupta', 'Iyer', 'Reddy', 'Nair', 'Das', 'Banerjee', 'Chowdhury', 'Khan',
  'Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Zhao', 'Wu', 'Zhou', 'Sato', 'Suzuki', 'Takahashi', 'Tanaka',
  'Watanabe', 'Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Nguyen', 'Tran', 'Le', 'Pham', 'Santoso', 'Wijaya', 'Reyes', 'Cruz',
  'Adeyemi', 'Okonkwo', 'Mensah', 'Asante', 'Kamau', 'Otieno', 'Mbeki', 'Ndlovu', 'Diallo', 'Traore', 'Bekele', 'Tesfaye',
  'Ahmadi', 'Cohen', 'Levi', 'Friedman', 'Katz', 'Rosen', 'Goldberg', 'Klein', 'Weiss', 'Stein', 'Mendes', 'Lima',
  'Castro', 'Vargas', 'Rojas', 'Mendoza', 'Herrera', 'Medina', 'Aguilar', 'Flores', 'Morales', 'Ortiz',
];

export const SAMPLE_CITIES: readonly string[] = [
  'London', 'Paris', 'Berlin', 'Madrid', 'Lisbon', 'Rome', 'Amsterdam', 'Brussels', 'Vienna', 'Prague', 'Warsaw', 'Dublin',
  'Edinburgh', 'Manchester', 'Bristol', 'Leeds', 'Lyon', 'Marseille', 'Nantes', 'Bordeaux', 'Toulouse', 'Nice', 'Seville',
  'Valencia', 'Bilbao', 'Granada', 'Porto', 'Braga', 'Coimbra', 'Faro', 'Milan', 'Naples', 'Turin', 'Florence', 'Bologna',
  'Genoa', 'Munich', 'Hamburg', 'Cologne', 'Leipzig', 'Dresden', 'Utrecht', 'Rotterdam', 'Leiden', 'Delft', 'Ghent',
  'Bruges', 'Antwerp', 'Geneva', 'Zurich', 'Basel', 'Oslo', 'Bergen', 'Stockholm', 'Uppsala', 'Copenhagen', 'Aarhus',
  'Helsinki', 'Tallinn', 'Riga', 'Vilnius', 'Krakow', 'Budapest', 'Bucharest', 'Sofia', 'Athens', 'Istanbul', 'Ankara',
  'Cairo', 'Lagos', 'Nairobi', 'Accra', 'Dakar', 'Kampala', 'Durban', 'Mumbai', 'Delhi', 'Chennai', 'Karachi', 'Dhaka',
  'Beijing', 'Shanghai', 'Tokyo', 'Osaka', 'Seoul', 'Busan', 'Hanoi', 'Bangkok', 'Jakarta', 'Manila', 'Sydney', 'Perth',
  'Darwin', 'Auckland', 'Toronto', 'Boston', 'Denver', 'Phoenix', 'Austin', 'Mobile', 'Reading', 'Bath',
];

export const SAMPLE_BRANDS: readonly string[] = [
  'Apple', 'Google', 'Amazon', 'Microsoft', 'Samsung', 'Sony', 'Nike', 'Adidas', 'Puma', 'Volvo', 'Toyota', 'Honda',
  'Ford', 'Tesla', 'Visa', 'Mastercard', 'Shell', 'Nestle', 'Danone', 'Heineken', 'Ikea', 'Lego', 'Zara', 'Gucci', 'Prada',
  'Chanel', 'Rolex', 'Canon', 'Nikon', 'Philips', 'Siemens', 'Bosch', 'Lidl', 'Aldi', 'Tesco', 'Uber', 'Spotify', 'Netflix',
  'Oracle', 'Intel', 'Dell', 'Lenovo', 'Xerox', 'Kodak', 'Pepsi', 'Fanta', 'Sprite', 'Kleenex', 'Jeep', 'Dove',
];

/** The fixed sample used for measurement: the first 200 / 200 / 100 / 50 of each list. */
export const NAME_SAMPLE = {
  givenNames: SAMPLE_GIVEN_NAMES.slice(0, 200),
  surnames: SAMPLE_SURNAMES.slice(0, 200),
  cities: SAMPLE_CITIES.slice(0, 100),
  brands: SAMPLE_BRANDS.slice(0, 50),
} as const;
