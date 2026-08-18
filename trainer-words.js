// Vendored English word list for the typing trainer — 4000 most frequent
// words, ordered by frequency, derived from eleven public-domain Project
// Gutenberg texts (Alice in Wonderland, Pride and Prejudice, Sherlock Holmes,
// Moby Dick, A Tale of Two Cities, The Time Machine, Frankenstein, Treasure
// Island, Tom Sawyer, Huckleberry Finn, Great Expectations).
//
// Built with a document-frequency filter (a word must appear in >= 3 of the
// eleven texts) so book-specific proper nouns and dialect drop out, and with
// contraction fragments ("s", "ll", "ve", "th") removed.
//
// Rank IS the frequency signal: weight = 1 / (rank + 3). That Zipf-Mandelbrot
// fit reproduces reference English letter frequencies to 3.3 percentage points
// summed over etaoinshrdlcu -- closer than the corpus's own raw counts -- so
// the file stays a plain word list with no counts to keep in sync.
//
// MUST stay byte-identical to AdeptCompanion's TrainerWords.swift: the two
// apps' lessons and per-key statistics are only comparable if they draw on the
// same corpus. Regenerate both together.

/** Frequency-ordered; index 0 is the most frequent word. */
export const WORDS = (
    "the and of to i a in it that was he you his with as had for my but at on me not her is be " +
    "him all have so she by this said there they from were we no which when one out what if up " +
    "would then or been now them an could do mr your their into more very man are some time upon " +
    "down like who little see well about will before know over again did any come than other how " +
    "here good old two such never only can way much after say should us long made got must go " +
    "these its don am our has back went first head where might think whale hand day off last ever " +
    "too may away great night own came still miss most nothing tom being every yet thought himself " +
    "though get just through looked look right while saw eyes make tell take took joe done let " +
    "why even three seemed found without house says going soon another put myself chapter face " +
    "same place those room shall round life hands thing once under mind side always seen yes many " +
    "heard door men elizabeth sir young left sea father dear half enough something oh ship give " +
    "looking far moment because better mrs quite told began along white both cried boy captain " +
    "towards people among felt things gone morning turned poor light knew ain home heart didn " +
    "against whole world few set between till having stood water name however part anything want " +
    "boat almost air find ye lay sister next jim nor doctor asked hear fire indeed sat work dead " +
    "friend around herself new hope word business kind sure end years lady each course perhaps " +
    "rather together keep dark words voice whom until open behind black small passed called days " +
    "coming brought matter times whether manner case does returned gave since often town high " +
    "best mother cannot near believe rest table king four pretty bed sometimes death taken jane " +
    "de within gentleman warn money woman feet help family full whose leave love also sort five " +
    "speak present wish wouldn mean sight hard hour less hold thus point couldn turn lost eye " +
    "body pocket kept strange arm least feel alone large else low window country call struck known " +
    "certain won line thou fell close really short already sun yourself letter child true answer " +
    "read replied wife evening idea fellow doubt hair god ask sound river run reason talk laid " +
    "ground use red itself either question street hardly across wanted held general strong mine " +
    "stand silver suddenly saying aunt used answered above others deck making therefore certainly " +
    "live ready stopped standing book ten tried became second none appeared several person taking " +
    "boys spoke london added cold means hours en followed minute hundred happy fear friends thousand " +
    "suppose state given ran nature walked arms chair remember clear wind corner deep opened bad " +
    "fish reckon account cut brother show everybody comes seem possible during try daughter getting " +
    "minutes sleep forward trouble mouth year presently length glad feeling foot subject chance " +
    "story silence fine uncle ago seeing return anybody blood dropped feelings late wild six easy " +
    "husband soul entered attention blue company iron heads afraid lord watch rose started care " +
    "twenty prisoner girl madame top doing ill breakfast power wonder change leg collins further " +
    "instant human pleasure walk carried received happened interest land road island paper aye " +
    "children son creature turning wood fast observed seems front wine hat village st natural " +
    "slowly sense clock remained different heavy clothes earth thinking broken free living crew " +
    "besides quiet dinner nobody wall object past ah continued mary thoughts sitting secret running " +
    "longer glass master order big truth cry piece floor bear gentlemen straight common sudden " +
    "boats stay below drew character except able shook shoulder showed lips mighty duke quick " +
    "trees neither opinion fact bring usual hill beyond repeated forth board talking bright silent " +
    "figure purpose cabin distance nearly met fixed pipe fancy dog stranger ought play shore women " +
    "green week bit bank save beautiful thee wait tears darkness early shot likely become surprise " +
    "died pass curious caught coat view woods heaven moved whatever write court perfectly john " +
    "church real safe engaged england happiness stop sent sail self form married fair plain hot " +
    "knowledge lived mast danger stone start please deal sky die middle judge spirits goes raised " +
    "miserable mere shut seven tone faces mile scene begun cause direction thank maybe worth exactly " +
    "eight morrow thy miles worse sorry single occasion trying garden english knows meant led " +
    "instantly entirely awful smoke wide sign voyage george raft age expected bottom bound ships " +
    "fall lying breath broke coach ladies somebody makes dare prison school dress spirit wished " +
    "carriage marriage hung waiting wrong notice outside places mark spot talked affection streets " +
    "surprised honour touch scarcely quarter fortune ways months pray step resolved passage hadn " +
    "reached beginning sharp devil broad knife effect instead leaving third box pale placed rope " +
    "lower fingers party neck putting speaking grew settled pleasant looks fresh although drink " +
    "smile nose tree drawing following supper cap knowed giving horse mate allowed gate beneath " +
    "eat walking legs thick follow cook closed lie steps stairs ears number law blow arrived afternoon " +
    "news changed tail rising dreadful visit consider need companion lamp vast queen hurry candle " +
    "holding threw journey believed sake joy noble ben twice crowd teeth asleep passing sweet " +
    "gold former public necessary dick william sit meet peculiar windows breast charles laughed " +
    "shop post duty office knowing strength otherwise wrote pride fifty satisfied dat mad begin " +
    "grave letters easily squire main greatest watson widow machine filled nine various loose " +
    "remarked kill pain horses slow ashore hole dressed merely spoken treasure weather supposed " +
    "beside ocean alive note vain occurred hanging waited girls pleased watching rich shadow colonel " +
    "sawyer creatures mentioned terror finally touched rooms horror ha pity listened papers greater " +
    "noticed dream delight somehow meaning tall spring south desire seas society bill bent lives " +
    "bread promise thrown seat sunday property formed finger moon act fool probably degree break " +
    "seated charge sailor pay drawn north killed beauty fallen written quietly yours terms rain " +
    "latter thirty soft steady honest paid colour glance city expect oil boots nearer cross books " +
    "weeks send unless worked cat french whenever kitchen lines terrible unknown slight stern " +
    "future misery curiosity sides possibly fetch laugh comfort wonderful calm rolled bell grand " +
    "yards exclaimed anxious imagine ourselves peace sick lead born bow pull drop waters escape " +
    "noise stick appear forget keeping remain forty yard strike bar traveller hurried leaves yesterday " +
    "pulled manners whispered proud tide wore summer judged mention lot spite handsome quickly " +
    "aside yellow pursued influence monster cast gentle charlotte lit wretched pause beat names " +
    "watched witness blind spy force ere situation complete cousin reading couple pieces respect " +
    "blame touching private key burst ring despair hearing grass grey inside carry clean memory " +
    "thunder laying trust listen hall shoulders history forehead lose pointed plan questions murder " +
    "works service luck vessel coffin empty crossed presented dance obliged guard thin dr inn " +
    "rum presence aboard knees worn ball vengeance learn houses position sisters agreeable regard " +
    "spent loved aged doors locked generally joined excellent shaking ear chief learned log expressed " +
    "lightning midnight finished spread directly draw telling picture france nights warm reckoned " +
    "hain plainly throw reply moving rise hid worst gradually art drove dust chase hopes dry game " +
    "paris wooden liked hoped bones laughing bag chest evil action gun match spare grow opening " +
    "speech drunk distant leaning regular seized headed surface according convinced innocent covered " +
    "ice dollars rate bottle forgotten growing explain lad loud rushed fit storm serious marked " +
    "calling ones difficult wake opposite previous fate lighted possessed waves marry hurt important " +
    "courage proper writing bless surely moments health assure forced anyway kindness aspect catch " +
    "golden reach savage queer grown rock officers tied horrible aloft favour cave tea finding " +
    "shoes twelve dogs birds offer handed youth turns higher daylight equal highly evidence dull " +
    "slipped conduct attempt advantage hearts fight beheld seek cases east glancing wholly tired " +
    "falling angry move bird jack precious shake double orders greatly snow square walls skin " +
    "perfect signs space pair allow glanced fashion arrival enter servant express chap occupied " +
    "path plenty roof sand brown suit drive indian hunter lies shown suspicion ahead visible harm " +
    "temper proved weak jaw remark parts younger upper condition dread advice burning nice deeply " +
    "sooner crying whisper sounds stretched removed bore enemy events west dozen perceived nigh " +
    "entire working assured address dim simple narrow pointing solemn jury addressed absence lifted " +
    "copyright sailors stars food loss ignorant odd existence meeting throat smoking evidently " +
    "bone striking intention success naturally bout forge temple somewhere lovely bye smiling " +
    "wet shape voices caused trial edge violent march buried flint stared sprang landlord swear " +
    "crime oars study period singular saint happen cool later seldom shining promised tongue carefully " +
    "upstairs wasn staring gained camp meantime sank behaviour somewhat bench job current spout " +
    "lights saved pushed receive roads solitary mock paused faint busy bringing month relief mystery " +
    "recovered setting hunt sailed ceased ease weight slept lantern craft goodness remains yonder " +
    "bet police ivory listening taste matters takes ancient flying anyone mortal bare sails excuse " +
    "bows likewise truly proceeded offered gives event similar guardian race tale turtle fifteen " +
    "forgot notion winter ordered shouted reasons instance baby wants majesty attended grief affair " +
    "wishes jolly mistaken excited rolling troubled pursuit earnest points confess equally stream " +
    "intervals lively amiable discovery rabbit aloud coast mistake hint drinking dig join justice " +
    "unable project united adventure observe ghost rough huge leaned heavily bearing bosom brow " +
    "cottage jumped chin beg pounds hide soldiers ho raise blessed extreme pockets command credit " +
    "thinks relations sought knitting fountain chain actually centre flowers pardon unhappy fly " +
    "played advance breaking quit dying dangerous mist regarded marks apart anxiety hammer aware " +
    "strongly lane coffee sensible examined mountains er ashamed gently softly delighted result " +
    "royal fairly stepped pick mates native shirt revenge sleeping sailing powers weary capable " +
    "tossed gray suffered prepared daughters wedding sally shadows den returning guess rush brain " +
    "alarm agony carrying mostly meanwhile directed prove affairs retired dared intended seamen " +
    "agreed familiar carpenter species facts parted utmost straw solid decided circle pressed " +
    "sad feared throwing sing eager dancing cries gratitude fro virtue skeleton careful destroyed " +
    "superior dearest stands attached mouse size rapidly avoid produced uneasy search hollow jump " +
    "hidden wound belief port separate amongst hence features obvious stock sympathy mass judgment " +
    "chamber stopping showing asking wondering lock station passion foolish nay stuff music helped " +
    "favourite share breeze gutenberg sheet desired grateful powerful liberty angel darted picked " +
    "height clearly blows flew cutting smiled meat pirates alongside language stones beach noon " +
    "famous firm claim example deadly interval stuck floating wear suffer depend secure saturday " +
    "staircase visitor prisoners stole pictures wise confusion lonely vanished song knee nodded " +
    "pie states war resumed pen increased stronger arose safety building shortly jacket mud failed " +
    "habit final connected painful dressing alas fur declared chimney folded personal butter flung " +
    "bitter cleared fears precisely effort triumph sum cheerful departed friendly add cloud group " +
    "objects monday suspected fully gloom row larger usually eagerly brass fancied prevent readily " +
    "settle gay explained special heat drank funeral due swift tore glory steadily gloomy swiftly " +
    "struggle season coarse baker candles brave welcome speed simply ceiling pulling succeeded " +
    "hare farther fellows kings cards narrative appears hang steel breathing dragged substance " +
    "track slip overboard heading probable murderer fatal receiving minds choose fail partly wreck " +
    "tear rendered heavens reference scared client hastily desperate sorts concluded hit missed " +
    "extremely flat kindly persons parlour ruin battle hunted distress smell advanced rage nearest " +
    "required contrary useless driven servants conscious escaped task false necessity nephew deeper " +
    "dismal profound courtyard field fond swimming proceed crown begged immense fix vague shock " +
    "kissed american cheek bars dreams stayed gracious pistol cape winds clouds civility concern " +
    "fetched midst employed informed suffering murdered sword pool wondered duchess animal ladder " +
    "wandered anger figures leading delay sink officer powder buy deserted tobacco rank roll merry " +
    "fill notes distinct disturbed gallery forgive fence bulwarks fiend degrees dignity thrust " +
    "progress inquiry henry ideas concerned suspended stir convict outer lake buck playing jaws " +
    "knocked singing tight anywhere described patient swinging flight cruel utterly willing guilty " +
    "shone report motion swung flag style torn level delicate affected tools acted fault spend " +
    "gang slid trembling hate hungry limbs beating crept poured eating kiss sorrow cheeks dropping " +
    "paying fierce custom tin stage shoved awoke block direct bushes ashes aid describe prospect " +
    "la recalled lip contents fitted burnt mixed nervous authority inclined raising muttered remaining " +
    "choice trademark count daily wanting sideways armed furniture signal details sold request " +
    "oar cover scattered silently starting extent trade awake pole fearful pains related anguish " +
    "mum lately hopeless violently capital sentence sensation swim elbow frame content constant " +
    "startled eh warning shade dirty wounded weakness bodily ride bundle score medical pile attend " +
    "served mild persuade christian hiding sunk design ends shed trace deed fortunate delicacy " +
    "inquiries hinted woe furnished endure bedroom rod heap inches sounded confused hunting haven " +
    "sell lasted branches violence enjoy relieved fourth accident gazing pirate heartily movement " +
    "unusual value bridge rang hailed gathered train landed dumb missing utter wot humour occasions " +
    "original discover science clerk moreover quantity lift rested lawyer intent taught useful " +
    "exact closely wandering banks treated fun someone modern uncommon chains fog wicked observing " +
    "eternal stroke mountain thanks hearted loaded suggested lads swept regret hills strangely " +
    "fever damp built behold hitherto passenger absent grounds objection visited endeavour roused " +
    "worthy quitted persuaded instances reflected band valley peter steal iii learnt earnestly " +
    "immediate plate brandy puzzled highest alarmed roared inquired stiff thanked beloved impatient " +
    "ragged haunted forms rid belonged amount pew thousands lodge seventy souls anchor faith fore " +
    "strain principal abroad guns crack lucky dashed absolute gain planks mill scenes generous " +
    "driving devoted delivered demanded folks keen pig ate bowed finish desk moral afford grace " +
    "horn supposing bold uttered comrade terrors perceive keel fishing bestowed landing owner " +
    "disposed scheme corpse reward admit fortnight ay estate dining chiefly amazement whilst niece " +
    "mankind joseph wretch keeper madness sixty pacific tower beings palace ii ma rats heels resting " +
    "slightest waist hers meal sheep bible murmured wrist consent rocks maid dine provided rigging " +
    "skill skiff ended aft victim clay retorted ordinary approach flesh exercise reserved reminded " +
    "amid ignorance file committed beer negro intense manage milk christmas salt wherever lest " +
    "invited backs hush editions shark deny admire lee whence handle record bulk charming bull " +
    "cloth painted faced hundreds agin invisible hail skull horizon hull commanded letting owing " +
    "seeking freedom doubtless german urged tolerable parting entering valuable energy prevented " +
    "brothers shoe agitation sarah corn hunger base jet blubber solomon tumbling flame nonsense " +
    "crowded goose enormous fat numerous barrel seaman contrast oath pitch wasted cursed grasp " +
    "risk page stout attracted astern slave tearing sheets echoes hoisted gets refuse enjoyment " +
    "floated attitude pilot certainty stirred sweat material park charm accept madam domestic " +
    "cared dreaded hotel fields revealed fastened problem wrapped chambers republic honor sadly " +
    "lesson solemnly footsteps swallowed needs stirring minded sigh entrance bite loving islands " +
    "wave mail pursue shaken conceal flash gates admitted bought thither alike unlike smooth snake " +
    "recall lofty stretch knives freely stump america happily evident relation yield borne referred " +
    "waiter rushing hideous rare gazed measure declare refused waste wash rule helpless collected " +
    "closer subjects applied monstrous glasses risen sees needed struggled troubles departure " +
    "thread moonlight advancing library plans crutch devils scarce shame coloured idle ringing " +
    "fired destroy serve cellar articles restored press gigantic uncertain intimate continue softened " +
    "eyeing proof regularly glimpse social restless travelled remote vessels store lean gale fishermen " +
    "practice belong burn swam hated eyed argument patience venture neat pressing loudly faster " +
    "shouting partner wig list overcome apply abandoned attack handy spanish weapon split cloak " +
    "senses compass tavern swore date named pound security forest trunk cheese solitude quest " +
    "rear jones summit separated trap accused creation accepted humanity birth danced market summoned " +
    "endured visitors reflect elder gaze closing drops travel victor managed doesn drowned cunning " +
    "trembled pleasing contempt dish crazy tossing seriously ugly cup accounts laughter lingering " +
    "chosen exhausted produce rode disgrace awhile blowing sober veil drag eagerness volume blank " +
    "dawn castle faithful smiles concealed prayer whereas polite divided roar descended frequent " +
    "basket slightly composure grim rags rapid hunters secured quality ages habits animated dislike " +
    "splendid blessing becomes encounter derived prey eleven sacred dutch sunset halloa watery " +
    "stillness runaway frightful laws merchant blast inch flames whiteness hast hell ghosts rat " +
    "largest older theirs remarks chose star using execution spell pace collar reality including " +
    "plank exposed released foreign arrive eyebrows innocence smart forever pork hesitated twisted " +
    "statement labour carpet heave quarters crossing price bodies southern card weep fleet practical " +
    "dwelling marrying vanity leisure severe elsewhere expense apartment tender assist satisfy " +
    "duties cents lawn hook emerged theory kinds official arthur sleepy lamps longed rules dried " +
    "gloves repeat wept shouldn smallest altered stool branch civil afore mouths examine globe " +
    "un print license pursuing heaving thankful imagined trifle awakened tables detail shudder " +
    "counter james desert fled glow perils impulse parties lowered mercy peril staggered holes " +
    "assurance bending backward copper praise variety passages incapable female awe education " +
    "wishing motive warmth created secrecy bride wonders sinking emotion winding spectacle stricken " +
    "turner matches iv cats blown expecting shiver gravely elegant fury tumbled cart clever upright " +
    "hearth rude tells begins humble pot calmly louis heel support strangers message contained " +
    "string lid tar leather clue admirable hither rusty desolate cannon union muskets stove clearing " +
    "waved blackness ghastly easier unnatural torture dimly thumb prolonged impressed feature " +
    "term counted gown attentive bestow wednesday assisted forming pavement ceremony parents condemned " +
    "sole deemed appointed repose drifting bachelor faded hum fiery cab glided holder ventured " +
    "pine advise happens attending slate guinea series swallow howling louder irons spoon rubbing " +
    "rubbed counting ink yo stare crimes pretended pillow supply burned rights leaped class punch " +
    "joke relate calls casting dreary marsh deceived portion stooping system lowering axe completed " +
    "pausing shooting gunwale sweeping relieve folly foam pose foul glare curse wealth frank extended " +
    "admired render feels dined obtained tendency income malice composed farewell article ascended " +
    "traces darling betwixt sofa chairs invested wing holy scuttle descried counsel toil league " +
    "marble peeped lessons whiskers curtain apple anxiously reaching timid offended animals feeble " +
    "knock soup plates breathe learning needn scream wildly cost tones treat blew canvas mischief " +
    "involved cattle ebook pin frost backed retreat basin sleeve foremost speedily mounted raging " +
    "descend riding respects confessed hanged swell spade boom injured prefer bits nodding stores " +
    "numbers keeps stooped snatched cracked creeping betrayed upward murmur peaceful doubted bitterly " +
    "leaf deserve romantic popular incident reproach families chaise eldest answering sacrifice " +
    "clergyman occur inquire prepare friday sentiment lover vice tackle terrific household fortunes " +
    "sermon needle unseen massive brewery hey watchman blanket ferry tick pretend smaller catching " +
    "bend growled finds coward tie arranged whistle changing changes checked crawling furious " +
    "holiday tails guilt rattle residence ruined owe saving beggar mount groping brief fools nod " +
    "propose enjoyed pipes clapped prayers openly agitated dug plunged destined recover sore musket " +
    "grove washed smoked supplied grasped truck upwards paddle reserve charged barrels views suspect " +
    "murderous improved subtle possess likeness injury earliest amusement gratified thereby formerly " +
    "seeming dirt shows capacity bears confined proposed rail honoured doubts bonnet sixteen succeed " +
    "neglected assumed magnitude firmly hears secrets rob scotland yielded premises keys frantic " +
    "fashioned customary precise witnesses pa knitted metal sweep bust twilight captured circus " +
    "vi picking flashed orange funny overhead eaten sharply washing panting absurd subdued bother " +
    "pan shaped waving beast examining balls bursting quarrel feather ours copy author obey blade " +
    "mourning steep shelter enemies continual hearty actual addition pure clumsy ribs newly haul " +
    "bailey galley outward naked stomach lighter stained awkward hark load gaining process source " +
    "angle dense billows combined boiling spared foe active flies piled preserve motives criminal " +
    "bred compared withdrew studying felicity illness remove check tuesday correct conveyed regarding " +
    "steward demand carved remorse poverty belonging parent refuge member vicinity hut wheels " +
    "beef minister drownded blazing tormented limb chased fain sung pulpit preacher plane divine " +
    "stupid waistcoat doorway lap fright nurse farmer rattling peering deepest nest introduce " +
    "proposal deserved brush chanced fighting arrow barley buttons follows cares faintly pencil " +
    "haste attempted spreading clasped runs nails hamlet beaten earlier nail clung debts usage " +
    "horrid saddle buildings immortal august voyages monkey lion qualities cask daring warmly " +
    "breathed infinite shout efforts northern boast lighting critical breadth causes wit recommend " +
    "etc county conceive imaginary guarded tolerably entreat purse performed determine elevated " +
    "arise china reception depart emotions principle conducted supported retained oppressed coachman " +
    "earthly sings reasoning shivered lifting shelf destiny absorbed inner national robbers linen " +
    "commence wheel serene tracks towers editor doom president lo cake grin belongs sorrowful " +
    "assembled hurriedly executed knocking decidedly crawled wings whoever natured corners ambition " +
    "belt neighbour bells royalties protect cease hastened gallows trick inform defence flood " +
    "brace unwilling blamed audible prospects dusk multitude mariner messenger smelt spray surgeon " +
    "bucket sons silly fowls seconds steering hauled richard watches chill gliding endless shove " +
    "caution sliding keenly starboard darting careless coolly tooth tragedy fatigue heaps chances " +
    "afforded genius disguise declined opinions gallant vacant exertion model flow preceding arrested " +
    "mutual allusion recollect preserved esteem suspense interview universal sleeves temporary " +
    "tradesman britain trousers rag burden conceived sublime measured barrier nation nameless " +
    "steamer busted wrinkled corridor slide atlantic image cannibal thine pots bronze float fan " +
    "soothing clinging favoured prize pleaded curled bark steam disgust pack sugar persisted fork " +
    "soldier stolen farm trip berth obeyed terrified shivering mingled harder palm kicked comrades " +
    "slope dash sport manned timber yielding jealousy cheer willingly snakes spinning curiously " +
    "method instinct colours stark geese shoot badly bloody brains sounding homeward guide announced " +
    "whip seize studied displayed effects exhibited protested cough grieved desirable lodgings " +
    "convey presume preparing properly assented mistress grandeur induced descent discourse audience " +
    "envelope tranquil tidings peep local blinds drooping swelled fruit packed passions admission " +
    "boot garret frock barred results tread restore lifeless cell dusty shattered agent fowl rows " +
    "brute witches lungs mood sights leagues elephant catched emigrant carries central wid vii " +
    "ix xii latitude downward poker sending digging leap dripping angrily knot crash isn sh flower " +
    "likes tremble extra permitted becoming gather fancies staying sich swing horrors gathering " +
    "increase guineas issued echoed frenzy dismissed rascal everyone banker despised begging brisk " +
    "youngest weighed carriages beats crews margin lightly leaping hero bags mustn exchanged thomas " +
    "glowing roaring safely logs groan cooked rays indicated heavier capture decide apology adopted " +
    "sunshine nostrils recent pushing happier accursed century actions tenderly entitled furnish " +
    "prevailed borrow gravity patron flowing momentary confident deceive walks accompany placing " +
    "inquiring sustained embraced seizing hired miseries vivid depth roman appalling moody mental " +
    "majestic jail coal spine coroner weeping pacing cigar wharf drifted sinister mystic depths " +
    "leak illinois viii xi dipped hurrying beds hoping poison hoarse shrill moderate chorus magic " +
    "yer whispers kick eggs repeating jumping denied mournful woke paint noticing screaming squeezed " +
    "toes squeeze signed childhood sorrows bacon decline alarming crooked interior pistols budge " +
    "appeal biscuit tramp stately dock isle fought lookout offering haired offence bid benefit " +
    "snapped anyhow cruelty pretence rejoined eastern lots pious silk eastward blaze sunlight " +
    "unearthly covering portable thirst bottles appetite sin weapons mid included villain melted " +
    "ropes traced merit induce studies prime parish mamma fatigued mode attorney apparent conceit " +
    "perform suggest abode confirmed military debt circles thursday amidst blasted hatred fare " +
    "errand phantom clutched strict lonesome brick dragging region decay shutters hue tub labours " +
    "rotten eighteen elephants closet brighter stair dover paced gesture clad muffled rogers bury " +
    "cavern dis waked beasts politely worm choked nowhere failure losing tasted tomorrow sobbing " +
    "appearing jug settling tempered hasn reduced boldly attempts furiously purple replace protected " +
    "threshold commander guest stories cutlass medicine visits coals bolt brings title perished " +
    "leastways rip doomed rely spending slain liberal prayed shipped contrived facing bleeding " +
    "lick british climbing snuff fourteen masses disturb infernal grain solemnity jewels beam " +
    "sleeper teach perilous reader springing glances boards pit coin seventeen co element frenchman " +
    "formal alluded nerves cautious activity wives symptoms injustice complied assume interfere " +
    "kent contented disdain believing complain enjoying intently sincerely worldly elapsed founded " +
    "stepping strongest stated token anew imparted obtain striving insisted pouring bills pint " +
    "battery apron greek shroud refer career sticking darker rot host vision alley deliver escort " +
    "tribe shuddered ee wrinkles planted tiger pumps physical searched structure centuries driver " +
    "daytime nailed glorious beware enchanted pepper wander printed presents lodging denial fifth " +
    "guessed shrieks fireplace worry forwards tricks timidly serpent graceful"
).split(" ");

/** Zipf-Mandelbrot rank weight, the corpus's only frequency channel. */
export const rankWeight = (rank) => 1 / (rank + 3);
