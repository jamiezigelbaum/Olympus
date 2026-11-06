import sys,os,numpy as np
sys.path.insert(0,'.')
import embed_lib as e
P={
'health':["medical appointment with the doctor","prescription medication and symptoms","lab results, diagnosis and treatment","therapy, mental health and depression","hospital visit, insurance claim for surgery"],
'money':["bank account balance and wire transfer","paying taxes, tax return and accountant","mortgage, loan and credit card debt","salary, invoice payment and investment portfolio","cryptocurrency wallet and funds transfer"],
'legal':["lawyer, lawsuit and legal settlement","contract agreement and signature","court hearing, divorce and custody","visa, immigration and legal status","terms of the NDA and liability"],
'receipts':["receipt for your order, total paid","invoice number, amount due and payment received","order confirmation and shipping","your subscription renewal and billing statement"],
'identity':["passport number and date of birth","social security number and driver license","home address and phone number","password, login code and account verification","ID card, birth certificate and tax ID"],
'chitchat':["haha lol that is funny","good morning, how are you doing","thanks, see you later","ok sounds good","happy birthday, congratulations"],
'links_news':["check out this article and link","news headline, video and tweet to read","sharing a website link and podcast","interesting blog post about technology"],
'logistics':["what time shall we meet, running late","meeting scheduled for tomorrow, calendar invite","where are we having dinner, address of the restaurant","flight and train times, pick up at the station","can you send the file, agenda for the call"],
}
m=e.local_embedder(threads=2)
names=[];txt=[]
for k,v in P.items():
    for t in v: names.append(k); txt.append('task: search result | query: '+t)
V=m.embed(txt)
np.save('probe_vec.npy',V); open('probe_names.txt','w').write('\n'.join(names))
