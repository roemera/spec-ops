// Quotes shown when you go down or bleed out, in the spirit of the old Call of Duty death screens.
// All are Donald J. Trump's own words: Truth Social posts (checked against the trumpstruth.org
// archive, linked by post), tweets, speeches and interviews (checked against news reports).
// "Reported" marks the two that come from people who heard him say them, not from a recording;
// he denies both. Long ones are cut with an ellipsis; nothing else is changed (spelling and
// capitals included).

export interface Quote {
  text: string;
  when: string; // shown under the quote
  source: string; // where it was checked: an archive link or the report
}

const TRUTH = 'https://www.trumpstruth.org/statuses/';

export const QUOTES: Quote[] = [
  // --- Truth Social ---
  { text: 'A whole civilization will die tonight, never to be brought back again. I don’t want that to happen, but it probably will.', when: 'Truth Social, April 7, 2026', source: `${TRUTH}37626` },
  { text: 'Iran should have signed the “deal” I told them to sign. What a shame, and waste of human life. Simply stated, IRAN CAN NOT HAVE A NUCLEAR WEAPON. I said it over and over again! Everyone should immediately evacuate Tehran!', when: 'Truth Social, June 16, 2025', source: `${TRUTH}31512` },
  { text: 'We know exactly where the so-called “Supreme Leader” is hiding. He is an easy target, but is safe there - We are not going to take him out (kill!), at least not for now.', when: 'Truth Social, June 17, 2025', source: `${TRUTH}31531` },
  { text: 'UNCONDITIONAL SURRENDER!', when: 'Truth Social, June 17, 2025', source: `${TRUTH}31532` },
  { text: 'ISRAEL. DO NOT DROP THOSE BOMBS. IF YOU DO IT IS A MAJOR VIOLATION. BRING YOUR PILOTS HOME, NOW!', when: 'Truth Social, June 24, 2025', source: `${TRUTH}31644` },
  { text: 'Last weekend, the United States successfully carried out a massive precision strike on Iran’s nuclear enrichment facilities, and it was very, very successful—It was called OBLITERATION.', when: 'Truth Social, June 25, 2025', source: `${TRUTH}31698` },
  { text: 'EVERYONE, KEEP OIL PRICES DOWN. I’M WATCHING! YOU’RE PLAYING RIGHT INTO THE HANDS OF THE ENEMY. DON’T DO IT!', when: 'Truth Social, June 23, 2025', source: `${TRUTH}31617` },
  { text: 'Because of other countries testing programs, I have instructed the Department of War to start testing our Nuclear Weapons on an equal basis.', when: 'Truth Social, November 5, 2025', source: `${TRUTH}33701` },
  { text: 'Afghanistan War: 20 years, 2,000 DEAD. Iraq War: 9 years, 4,600 DEAD. Vietnam War: 19 years and 5 months, 58,220 DEAD. Korean War: 3 years and 1 month, 36,574 DEAD. Venezuela War: 1 day, 0 DEAD. Iran Military Conflict: 4 months, 18 DEAD.', when: 'Truth Social, July 21, 2026', source: `${TRUTH}40174` },
  { text: 'If Iran doesn’t FULLY OPEN, WITHOUT THREAT, the Strait of Hormuz, within 48 HOURS from this exact point in time, the United States of America will hit and obliterate their various POWER PLANTS, STARTING WITH THE BIGGEST ONE FIRST! Thank you for your attention to this matter.', when: 'Truth Social, March 21, 2026', source: `${TRUTH}37387` },
  { text: 'Every time Iran kills an American Soldier they will pay for that killing many times over!', when: 'Truth Social, July 20, 2026', source: `${TRUTH}40158` },
  { text: 'Our Military, the greatest and most powerful (by far!) anywhere in the World, hasn’t even started destroying what’s left in Iran. Bridges next, then Electric Power Plants!', when: 'Truth Social, April 3, 2026', source: `${TRUTH}37573` },
  { text: 'Now with the death of Iran, the greatest enemy America has is the Radical Left, Highly Incompetent, Democrat Party! Thank you for your attention to this matter.', when: 'Truth Social, March 22, 2026', source: `${TRUTH}37398` },
  { text: 'Many of Iran’s Military Leaders, who have led them poorly and unwisely, are terminated, along with much else, with this massive strike in Tehran!', when: 'Truth Social, April 4, 2026', source: `${TRUTH}37591` },
  { text: 'We are locked and loaded and ready to go. Thank you for your attention to this matter!', when: 'Truth Social, January 2, 2026', source: `${TRUTH}34403` },
  { text: 'If Hamas continues to kill people in Gaza, which was not the Deal, we will have no choice but to go in and kill them. Thank you for your attention to this matter!', when: 'Truth Social, October 16, 2025', source: `${TRUTH}33333` },
  { text: 'If they do “assassinate President Trump,” which is always a possibility, I hope that America obliterates Iran, wipes it off the face of the Earth — If that does not happen, American Leaders will be considered “gutless” cowards!', when: 'Truth Social, July 25, 2024', source: `${TRUTH}24048` },
  { text: 'This is in retribution for yesterday’s bombing of ships by Iran. If it happens again, it will get much worse!', when: 'Truth Social, July 8, 2026', source: `${TRUTH}39899` },
  { text: 'The War has diminished Iran! It doesn’t, any longer, have an Air Force, a Navy, Antiaircraft Equipment, Radar, or practically anything else… How stupid can some people be???', when: 'Truth Social, June 19, 2026', source: `${TRUTH}39376` },
  { text: 'OIL IS FLOWING, IRAN CAN NEVER HAVE A NUCLEAR WEAPON (THE WORLD WILL BE SAFE!), THE STOCK MARKETS ARE ROARING, JOBS ARE AT RECORDS, AND PRICES ARE DROPPING (AFFORDABILITY!). OUR COUNTRY IS STRONG, SAFE, AND RESPECTED LIKE NEVER BEFORE. “YOU’RE WELCOME!”', when: 'Truth Social, June 18, 2026', source: `${TRUTH}39347` },
  { text: 'Short term oil prices, which will drop rapidly when the destruction of the Iran nuclear threat is over, is a very small price to pay for U.S.A., and World, Safety and Peace. ONLY FOOLS WOULD THINK DIFFERENTLY!', when: 'Truth Social, March 8, 2026', source: `${TRUTH}37208` },
  { text: 'Someone should explain to the Pope that the Mayor of Chicago is useless, and that Iran cannot have a Nuclear Weapon!', when: 'Truth Social, May 30, 2026', source: `${TRUTH}38911` },
  { text: 'Somebody please explain to kooky Tucker Carlson that,” IRAN CAN NOT HAVE A NUCLEAR WEAPON!”', when: 'Truth Social, June 16, 2025', source: `${TRUTH}31516` },
  { text: 'Iran has agreed to never have a Nuclear Weapon! Also, the story that the U.S. is paying Iran 300 million Dollars is Fake News, put out by the Dumocrats!!!', when: 'Truth Social, June 15, 2026', source: `${TRUTH}39295` },
  { text: 'Iran has agreed to never close the Strait of Hormuz again. It will no longer be used as a weapon against the World!', when: 'Truth Social, April 17, 2026', source: `${TRUTH}37837` },
  { text: 'The killing of innocent Christians in Nigeria — and anywhere — must end immediately. The Department of War is preparing for action.', when: 'Truth Social, November 1, 2025', source: `${TRUTH}33569` },
  { text: 'I am not happy with the Russian strikes on KYIV. Not necessary, and very bad timing. Vladimir, STOP! 5000 soldiers a week are dying.', when: 'Truth Social, April 24, 2025', source: `${TRUTH}30759` },
  { text: 'OUR GREAT MILITARY PARADE IS ON, RAIN OR SHINE. REMEMBER, A RAINY DAY PARADE BRINGS GOOD LUCK. I’LL SEE YOU ALL IN D.C.', when: 'Truth Social, June 14, 2025', source: `${TRUTH}31499` },
  { text: 'Everyone is asking who am I supporting, Army or Navy? My answer is: “You must be joking if you think I’m going to give you that answer!”', when: 'Truth Social, December 13, 2025', source: `${TRUTH}34221` },
  { text: 'It will be a big day with the Navy. Leaving now. The United States has the greatest military, by far, in the World. This will be a show of Naval aptitude and strength. ENJOY WATCHING!', when: 'Truth Social, October 5, 2025', source: `${TRUTH}33203` },
  { text: 'This great and very important military asset sits atop the heavily protected Ballroom at the White House. It provides National Security for Washington, D.C., and will protect future Presidents!!!', when: 'Truth Social, August 8, 2026', source: `${TRUTH}40646` },
  { text: 'The Great Ballroom and Military Complex being built at the White House. Very exciting! When completed, it will be the finest of its kind, anywhere in the World!', when: 'Truth Social, October 3, 2026', source: `${TRUTH}42099` },
  { text: 'Palantir Technologies (PLTR) has proven to have great war fighting capabilities and equipment. Just ask our enemies!!!', when: 'Truth Social, April 10, 2026', source: `${TRUTH}37688` },
  { text: 'Just had a great talk with our Military Leaders. It is the strongest Military we have ever had, including the fact that we are stockpiling weapons at a rate never seen before by our Country. Hopefully, however, we will never have to use them!', when: 'Truth Social, June 2, 2025', source: `${TRUTH}31343` },
  { text: 'For our adversaries, there is no greater fear than the United States Army. But for the American People, there is no greater pride—because YOU are the righteous sword of American Justice, and the ultimate shield of American Freedom!', when: 'Truth Social, June 10, 2025', source: `${TRUTH}31456` },
  { text: 'I told Canada, which very much wants to be part of our fabulous Golden Dome System, that it will cost $61 Billion Dollars if they remain a separate, but unequal, Nation, but will cost ZERO DOLLARS if they become our cherished 51st State.', when: 'Truth Social, May 27, 2025', source: `${TRUTH}31268` },
  { text: 'The way the U.S. is going, we will soon be in World War lll, with NO AMMUNITION!', when: 'Truth Social, April 10, 2023', source: `${TRUTH}15376` },
  { text: 'I had NO WARS. I’m the only president in 72 years that didn’t have any wars!', when: 'Truth Social, January 11, 2024', source: `${TRUTH}6366` },
  { text: 'I am the only candidate who can make this promise to you: I will prevent World War III !!!', when: 'Truth Social, December 18, 2023', source: `${TRUTH}7564` },
  { text: 'Russia has today threatened to use Nuclear Weapons, and we have Low IQ individuals, the same that messed up Afghanistan (who don’t have a clue!), in charge of this deadly situation. NO GOOD — NOT ACCEPTABLE!!!', when: 'Truth Social, September 14, 2024', source: `${TRUTH}26201` },
  { text: 'NOT TO MENTION THE PROBABILITY OF WORLD WAR lll IF THESE VERY STUPID PEOPLE REMAIN IN OFFICE. REMEMBER, TRUMP WAS RIGHT ABOUT EVERYTHING!!!', when: 'Truth Social, August 5, 2024', source: `${TRUTH}24481` },
  { text: 'Because she’s Lonely, and Crazy as a bedbug! She needs to be away from home, especially at this moment, even if it starts World War III.', when: 'Truth Social, July 31, 2022', source: `${TRUTH}21646` },
  { text: 'Wrong, and not even close. Nuclear War is the biggest threat!', when: 'Truth Social, February 1, 2023', source: `${TRUTH}17137` },
  { text: 'THIS WAR WAS TOTALLY PREVENTABLE. IT SHOULD HAVE NEVER HAPPENED. IF I WERE PRESIDENT, IT WOULD NOT HAVE HAPPENED!', when: 'Truth Social, October 1, 2024', source: `${TRUTH}26851` },
  { text: 'Our beautiful World War II Memorial was just hit by Spray Painting Vandals… We are on their trail! Where do these animals come from???', when: 'Truth Social, August 14, 2026', source: `${TRUTH}40818` },
  { text: 'He is CRAZY!!! He better straighten it out, FAST, or we’re coming!', when: 'Truth Social, August 30, 2025', source: `${TRUTH}32791` },
  { text: 'Anybody burning the American Flag will be subject to one year in prison. You will be immediately arrested. Thank you for your attention to this matter!', when: 'Truth Social, October 3, 2025', source: `${TRUTH}33194` },
  { text: 'Just say NO (Nuclear Option!). TERMINATE THE FILIBUSTER!', when: 'Truth Social, November 7, 2025', source: `${TRUTH}33724` },
  { text: 'Windmills are killing all of our beautiful Bald Eagles!', when: 'Truth Social, December 30, 2025', source: `${TRUTH}34381` },
  { text: 'The damage to the Nuclear sites in Iran is said to be “monumental.” The hits were hard and accurate. Great skill was shown by our military. Thank you!', when: 'Truth Social, June 22, 2025', source: `${TRUTH}31610` },

  // --- Speeches, interviews, tweets ---
  { text: 'He’s not a war hero. He was a war hero because he was captured. I like people who weren’t captured.', when: 'On John McCain, Ames, Iowa, July 18, 2015', source: 'Family Leadership Summit (video)' },
  { text: 'I know more about ISIS than the generals do, believe me.', when: 'Rally, Fort Dodge, Iowa, November 12, 2015', source: 'Rally (video)' },
  { text: 'I would bomb the shit out of ’em.', when: 'On ISIS, rally, Fort Dodge, Iowa, November 12, 2015', source: 'Rally (video)' },
  { text: 'I would say I’m the most militaristic person on the stage, but I would also say that I know when to do it.', when: 'Morning Joe, November 2015', source: 'Fox News, Washington Examiner' },
  { text: 'Our army manned the air, it rammed the ramparts, it took over the airports, it did everything it had to do.', when: 'Salute to America, July 4, 2019', source: 'Speech (video)' },
  { text: 'I always wanted to get the Purple Heart. This was much easier.', when: 'Ashburn, Virginia, August 2, 2016', source: 'Rally (video)' },
  { text: 'It’s my personal Vietnam. I feel like a great and very brave soldier.', when: 'On avoiding STDs, The Howard Stern Show, 1997', source: 'Radio interview (recording)' },
  { text: 'It’s actually much better because everyone [who] gets the Congressional Medal of Honor, they’re soldiers. They’re either in very bad shape because they’ve been hit so many times by bullets or they’re dead.', when: 'On the Medal of Freedom, Bedminster, August 15, 2024', source: 'CNN, CBS News' },
  { text: 'They will be met with fire and fury like the world has never seen.', when: 'On North Korea, Bedminster, August 8, 2017', source: 'Remarks (video)' },
  { text: 'Will someone from his depleted and food starved regime please inform him that I too have a Nuclear Button, but it is a much bigger & more powerful one than his, and my Button works!', when: 'Twitter, January 2, 2018', source: 'Tweet' },
  { text: 'Rocket Man is on a suicide mission for himself and for his regime.', when: 'United Nations General Assembly, September 19, 2017', source: 'Speech (video)' },
  { text: 'The United States has great strength and patience, but if it is forced to defend itself or its allies, we will have no choice but to totally destroy North Korea.', when: 'United Nations General Assembly, September 19, 2017', source: 'Speech (video)' },
  { text: 'Why would Kim Jong-un insult me by calling me “old,” when I would NEVER call him “short and fat?”', when: 'Twitter, November 11, 2017', source: 'Tweet' },
  { text: 'And then we fell in love, okay? No, really. He wrote me beautiful letters.', when: 'On Kim Jong Un, Wheeling, West Virginia, September 29, 2018', source: 'CNBC, The Hill' },
  { text: 'NEVER, EVER THREATEN THE UNITED STATES AGAIN OR YOU WILL SUFFER CONSEQUENCES THE LIKES OF WHICH FEW THROUGHOUT HISTORY HAVE EVER SUFFERED BEFORE.', when: 'To Iran’s president, Twitter, July 22, 2018', source: 'Tweet' },
  { text: 'If Iran wants to fight, that will be the official end of Iran. Never threaten the United States again!', when: 'Twitter, May 19, 2019', source: 'Tweet' },
  { text: 'If Turkey does anything that I, in my great and unmatched wisdom, consider to be off limits, I will totally destroy and obliterate the Economy of Turkey (I’ve done before!).', when: 'Twitter, October 7, 2019', source: 'Tweet' },
  { text: 'Don’t be a tough guy. Don’t be a fool!', when: 'Letter to President Erdoğan, October 9, 2019', source: 'White House letter' },
  { text: 'If we wanted to fight a war in Afghanistan and win it, I could win it in a week. I just don’t want to kill 10 million people.', when: 'With Imran Khan, White House, July 22, 2019', source: 'CNN, Military Times' },
  { text: 'Afghanistan would be wiped off the face of the earth, it would be over in literally in 10 days.', when: 'With Imran Khan, White House, July 22, 2019', source: 'CNN, Military Times' },
  { text: 'Probably the only thing Barack Obama & I have in common is that we both had the honor of firing Jim Mattis, the world’s most overrated General.', when: 'Twitter, June 3, 2020', source: 'Tweet' },
  { text: 'I view it, in a sense, as a wartime president.', when: 'On the pandemic, March 18, 2020', source: 'White House briefing (video)' },
  { text: 'When the looting starts, the shooting starts.', when: 'Twitter, May 29, 2020', source: 'Tweet' },
  { text: 'Proud Boys, stand back and stand by.', when: 'Presidential debate, September 29, 2020', source: 'Debate (video)' },
  { text: 'We fight like hell. And if you don’t fight like hell, you’re not going to have a country anymore.', when: 'The Ellipse, January 6, 2021', source: 'Speech (video)' },
  { text: 'We should use some of these dangerous cities as training grounds for our military.', when: 'To the generals, Quantico, September 30, 2025', source: 'C-SPAN' },
  { text: 'If you don’t like what I’m saying, you can leave the room. Of course, there goes your rank, there goes your future.', when: 'To the generals, Quantico, September 30, 2025', source: 'Grabien, CNN' },
  { text: 'We want to be defensive, but we want to be offensive, too, if we have to be.', when: 'On renaming it the Department of War, September 2025', source: 'CBS News' },
  { text: 'She’s a radical war hawk. Let’s put her with a rifle standing there with nine barrels shooting at her, OK? Let’s see how she feels about it, you know, when the guns are trained on her face.', when: 'On Liz Cheney, Glendale, Arizona, October 31, 2024', source: 'CBS News, NBC News' },
  { text: 'I think it should be very easily handled by, if necessary, by National Guard, or if really necessary, by the military.', when: 'On “the enemy from within,” Fox News, October 13, 2024', source: 'PBS NewsHour' },
  { text: 'Now, if I don’t get elected, it’s going to be a bloodbath for the whole — that’s going to be the least of it.', when: 'Vandalia, Ohio, March 16, 2024', source: 'Rally (video)' },
  { text: 'I could stand in the middle of Fifth Avenue and shoot somebody and I wouldn’t lose any voters, okay?', when: 'Sioux Center, Iowa, January 23, 2016', source: 'Rally (video)' },
  { text: 'Knock the crap out of them, would you? Seriously. Okay? Just knock the hell — I promise you, I will pay for the legal fees.', when: 'Cedar Rapids, Iowa, February 1, 2016', source: 'Rally (video)' },
  { text: 'I’d like to punch him in the face, I’ll tell ya.', when: 'On a protester, Las Vegas, February 22, 2016', source: 'Rally (video)' },
  { text: 'I’ll take electrocution every single time. I’m not getting near the shark.', when: 'Las Vegas, June 9, 2024', source: 'Rally (video)' },
  { text: 'And is there a way we can do something like that, by injection inside or almost a cleaning?', when: 'On disinfectant, White House briefing, April 23, 2020', source: 'Briefing (video)' },
  { text: 'In Springfield, they’re eating the dogs. The people that came in, they’re eating the cats.', when: 'Presidential debate, September 10, 2024', source: 'Debate (video)' },
  { text: 'If you have a windmill anywhere near your house, congratulations, your house just went down 75 percent in value. And they say the noise causes cancer.', when: 'NRCC dinner, April 2, 2019', source: 'Speech (video)' },
  { text: 'The late, great Hannibal Lecter.', when: 'Campaign rallies, 2024', source: 'Rally (video)' },
  { text: 'Nobody knew health care could be so complicated.', when: 'February 27, 2017', source: 'Remarks (video)' },
  { text: 'I love the poorly educated.', when: 'Las Vegas, February 23, 2016', source: 'Victory speech (video)' },
  { text: 'Nobody knows the system better than me, which is why I alone can fix it.', when: 'Republican National Convention, July 21, 2016', source: 'Speech (video)' },
  { text: 'I know words. I have the best words.', when: 'Hilton Head, South Carolina, December 30, 2015', source: 'Rally (video)' },
  { text: 'We’re going to win so much, you’re going to be so sick and tired of winning.', when: 'Campaign rally, 2016', source: 'Rally (video)' },
  { text: 'Despite the constant negative press covfefe', when: 'Twitter, May 31, 2017', source: 'Tweet' },
  { text: 'I think that would qualify as not smart, but genius....and a very stable genius at that!', when: 'Twitter, January 6, 2018', source: 'Tweet' },
  { text: 'He’s now president for life. President for life. No, he’s great. And look, he was able to do that. I think it’s great. Maybe we’ll have to give that a shot some day.', when: 'On Xi Jinping, Mar-a-Lago, March 3, 2018', source: 'Recording (CNN)' },
  { text: 'I’ll have that done in 24 hours.', when: 'On ending the war in Ukraine, CNN town hall, May 10, 2023', source: 'Town hall (video)' },
  { text: 'The concept of global warming was created by and for the Chinese in order to make U.S. manufacturing non-competitive.', when: 'Twitter, November 6, 2012', source: 'Tweet' },
  { text: 'Sorry losers and haters, but my I.Q. is one of the highest -and you all know it!', when: 'Twitter, May 8, 2013', source: 'Tweet' },
  { text: 'Except for day one.', when: 'Asked if he would be a dictator, Fox News town hall, December 5, 2023', source: 'Town hall (video)' },

  // --- Reported: heard by others, not recorded (he denies both) ---
  { text: 'Why should I go to that cemetery? It’s filled with losers.', when: 'Reported by The Atlantic, of a 2018 visit to France', source: 'The Atlantic, September 3, 2020; confirmed by John Kelly, 2023' },
  { text: 'I need the kind of generals that Hitler had.', when: 'Reported by John Kelly', source: 'The Atlantic, October 22, 2024' },
];

/** The next quote, dealt from a shuffled deck so none repeats until all have shown. */
let deck: Quote[] = [];
export function nextQuote(): Quote {
  if (!deck.length) deck = [...QUOTES].sort(() => Math.random() - 0.5);
  return deck.pop()!;
}
